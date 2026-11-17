#!/usr/bin/env python3
"""Attach Apollo LinkedIn URLs to the Ashby candidates already sitting in Leads.

The webhook sets `linkedInUrl` at candidate-create time, but some leads still have
a blank LinkedIn: everyone synced before that shipped, and anyone the hourly cron
backfilled (it reads sent messages, which carry no LinkedIn) whose webhook never
followed. This fills those in for the lead population only, on every job in
sequence_job_map (the people a recruiter actually opens), leaving the archived
pile alone.

Both sides are read in BULK rather than per-candidate, which is the whole trick:

  * Apollo's contacts/search is capped at 400/hour and 2000/day and is SHARED with
    the live Worker, so a per-contact lookup (one call per lead) would starve the sync for
    a day. Paginating the whole workspace instead costs one call per 100 contacts
    for every email -> linkedin_url pair.
  * Ashby's candidate.list returns socialLinks, so we learn who already has a
    LinkedIn without spending a candidate.info per person.

Safety rails:
  * only candidates whose application on the job is in Lead status (Reached Out /
    Replied) — archived and advanced candidates are untouched
  * never overwrites an existing LinkedIn; a recruiter's own entry outranks Apollo's
  * only accepts normalized personal /in/ profile URLs (company pages rejected)
  * idempotent — a second run finds nothing left to do

Usage:
    python3 scripts/backfill_linkedin.py --dry-run
    python3 scripts/backfill_linkedin.py --limit 5
    python3 scripts/backfill_linkedin.py
    python3 scripts/backfill_linkedin.py --mark-only   # stamp D1 from Ashby state
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Cloudflare (in front of both APIs) 403s the default python-urllib User-Agent.
UA = "curl/8.4"
APOLLO_BASE = "https://api.apollo.io/api/v1"
ASHBY_BASE = "https://api.ashbyhq.com"


def secret(name: str) -> str:
    for line in (ROOT / ".dev.vars").read_text().splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    sys.exit(f"{name} not found in .dev.vars")


def post(url: str, body: dict, headers: dict, tries: int = 5) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={**headers, "User-Agent": UA}
    )
    for attempt in range(tries):
        try:
            return json.load(urllib.request.urlopen(req, timeout=90))
        except urllib.error.HTTPError as err:
            if err.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"{url} -> HTTP {err.code}: {err.read()[:300]!r}") from err
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def normalize_linkedin(raw) -> str | None:
    """Mirror of normalizeLinkedInUrl() in src/apollo.ts — keep the two in step.

    Apollo stores `http://www.linkedin.com/in/<slug>`; Ashby validates linkedInUrl
    as a URL. Case is left alone deliberately: Apollo lowercases what it stores, and
    rewriting case would corrupt an opaque /in/ACwAA… token.
    """
    if not raw or not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or "{{" in raw:
        return None
    if "://" not in raw:
        raw = "https://" + raw
    try:
        u = urllib.parse.urlsplit(raw)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if host != "linkedin.com" and not host.endswith(".linkedin.com"):
        return None
    if not u.path.lower().startswith("/in/"):
        return None
    path = u.path.rstrip("/")
    if path == "/in":
        return None
    return f"https://{host}{path}"


# --------------------------------------------------------------------------
# Ashby
# --------------------------------------------------------------------------

def ashby_headers(key: str) -> dict:
    auth = base64.b64encode(f"{key}:".encode()).decode()
    return {"Authorization": f"Basic {auth}", "Content-Type": "application/json"}


def ashby_paginate(headers: dict, method: str, body: dict) -> list:
    out, cursor = [], "start"
    while True:
        data = post(f"{ASHBY_BASE}/{method}", {**body, "cursor": cursor, "limit": 100}, headers)
        if not data.get("success", True):
            raise RuntimeError(f"{method}: {data.get('errors')}")
        out += data.get("results", [])
        if not data.get("moreDataAvailable"):
            return out
        cursor = data.get("nextCursor")
        if not cursor:
            return out


def mapped_job_ids() -> list:
    """Every Ashby job a sequence routes to, read from sequence_job_map."""
    out = d1_query("SELECT DISTINCT ashby_job_id FROM sequence_job_map")
    return [r["ashby_job_id"] for r in out]


def lead_candidate_ids(headers: dict, job_ids: list) -> set:
    """Candidates whose application on a mapped job is still in a Lead stage."""
    ids = set()
    for job_id in job_ids:
        apps = ashby_paginate(headers, "application.list", {"jobId": job_id})
        leads = 0
        for a in apps:
            if a.get("status") != "Lead":
                continue
            cid = (a.get("candidate") or {}).get("id")
            if cid:
                ids.add(cid)
                leads += 1
        print(f"  job {job_id}: {len(apps)} applications, {leads} in Lead status")
    return ids


def all_candidates(headers: dict) -> dict:
    """id -> {email, has_linkedin, name}, read in bulk so we skip per-person info calls."""
    out = {}
    for c in ashby_paginate(headers, "candidate.list", {}):
        email = ((c.get("primaryEmailAddress") or {}).get("value") or "").lower()
        if not email:
            for e in c.get("emailAddresses") or []:
                if e.get("value"):
                    email = e["value"].lower()
                    break
        out[c["id"]] = {
            "email": email,
            "name": c.get("name"),
            "has_linkedin": any(
                l.get("type") == "LinkedIn" and l.get("url")
                for l in (c.get("socialLinks") or [])
            ),
        }
    return out


# --------------------------------------------------------------------------
# Apollo
# --------------------------------------------------------------------------

def apollo_linkedin_by_email(key: str, max_pages: int = 500) -> dict:
    """email -> normalized LinkedIn URL for the whole Apollo workspace.

    One call per 100 contacts. Doing this per-candidate would exhaust the budget
    the live Worker needs for routing lookups.
    """
    headers = {"x-api-key": key, "Content-Type": "application/json", "Accept": "application/json"}
    out = {}
    for page in range(1, max_pages + 1):
        data = post(f"{APOLLO_BASE}/contacts/search", {"per_page": 100, "page": page}, headers)
        contacts = data.get("contacts") or []
        if not contacts:
            break
        for c in contacts:
            email = (c.get("email") or "").lower()
            url = normalize_linkedin(c.get("linkedin_url"))
            if email and url:
                out[email] = url
        total_pages = (data.get("pagination") or {}).get("total_pages") or 1
        if page >= total_pages:
            break
        time.sleep(0.3)  # stay well under the 400/hour ceiling
    return out


# --------------------------------------------------------------------------
# D1 bookkeeping (best-effort — never gates the Ashby write)
# --------------------------------------------------------------------------

def d1(sql: str) -> None:
    subprocess.run(
        ["npx", "wrangler", "d1", "execute", "apollo-ashby-sync", "--remote", "--command", sql],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )


def d1_query(sql: str, tries: int = 4) -> list:
    """Rows from a read. wrangler's first call often fails 7403 while its token refreshes."""
    for attempt in range(tries):
        res = subprocess.run(
            ["npx", "wrangler", "d1", "execute", "apollo-ashby-sync", "--remote", "--json",
             "--command", sql],
            cwd=ROOT, capture_output=True, text=True,
        )
        try:
            return json.loads(res.stdout)[0]["results"]
        except (ValueError, KeyError, IndexError):
            time.sleep(3)
    sys.exit(f"D1 read failed: {res.stdout[:300]} {res.stderr[:300]}")


def sql_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def stamp_d1(pairs: list) -> None:
    """Record what we attached, in batches, so the column reflects reality."""
    for i in range(0, len(pairs), 100):
        chunk = pairs[i : i + 100]
        cases = " ".join(
            f"WHEN {sql_quote(email)} THEN {sql_quote(url)}" for email, url in chunk
        )
        emails = ", ".join(sql_quote(e) for e, _ in chunk)
        try:
            d1(
                f"UPDATE contacts SET linkedin_url = CASE email {cases} END "
                f"WHERE email IN ({emails});"
            )
        except subprocess.CalledProcessError as err:
            print(f"  ! D1 stamp failed for batch {i // 100}: {err.stderr[:200]}")
            return
    print(f"  stamped {len(pairs)} row(s) in D1")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--limit", type=int, help="stop after N updates (smoke test)")
    ap.add_argument("--csv", help="write the planned/applied changes to this path")
    ap.add_argument("--mark-only", action="store_true",
                    help="skip Ashby writes; just stamp D1 from Ashby's current state")
    args = ap.parse_args()

    ashby_key = secret("ASHBY_API_KEY")
    apollo_key = secret("APOLLO_MASTER_KEY")
    headers = ashby_headers(ashby_key)

    print("Reading Ashby applications…")
    leads = lead_candidate_ids(headers, mapped_job_ids())
    print("Reading Ashby candidates…")
    candidates = all_candidates(headers)
    print(f"  {len(candidates)} candidates in the workspace")

    already = sum(1 for cid in leads if candidates.get(cid, {}).get("has_linkedin"))
    print(f"  {already} lead(s) already have a LinkedIn — leaving those alone")

    print("Reading Apollo contacts…")
    apollo = apollo_linkedin_by_email(apollo_key)
    print(f"  {len(apollo)} Apollo contacts with a usable /in/ profile URL")

    todo, no_email, no_match = [], 0, 0
    for cid in sorted(leads):
        info = candidates.get(cid)
        if not info:
            continue
        if info["has_linkedin"]:
            continue
        if not info["email"]:
            no_email += 1
            continue
        url = apollo.get(info["email"])
        if not url:
            no_match += 1
            continue
        todo.append((cid, info["email"], info["name"], url))

    print(
        f"\n{len(todo)} to update | {already} already had one | "
        f"{no_match} no Apollo LinkedIn | {no_email} no email on file"
    )

    if args.csv:
        with open(args.csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["candidate_id", "email", "name", "linkedin_url"])
            w.writerows(todo)
        print(f"wrote {args.csv}")

    if args.mark_only:
        stamp_d1([(e, u) for _, e, _, u in todo])
        return

    if args.dry_run:
        for cid, email, name, url in todo[:10]:
            print(f"  would set {name} <{email}> -> {url}")
        if len(todo) > 10:
            print(f"  … and {len(todo) - 10} more")
        return

    done, failed = [], 0
    for n, (cid, email, name, url) in enumerate(todo, 1):
        if args.limit and len(done) >= args.limit:
            print(f"stopping at --limit {args.limit}")
            break
        try:
            post(f"{ASHBY_BASE}/candidate.update",
                 {"candidateId": cid, "linkedInUrl": url}, headers)
            done.append((email, url))
        except Exception as err:
            failed += 1
            print(f"  ! {email}: {err}")
        if n % 100 == 0:
            print(f"  {n}/{len(todo)}…")

    print(f"\nattached {len(done)} LinkedIn URL(s), {failed} failed")
    if done:
        stamp_d1(done)


if __name__ == "__main__":
    main()
