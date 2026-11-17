#!/usr/bin/env python3
"""Archive Ashby leads that have been pruned out of their Apollo sequence.

A contact that was emailed, never replied, and was then removed from the Apollo
sequence is dead outreach — but the sync leaves them parked in "Reached Out"
forever. This finds those and archives them as "Did Not Respond to Outreach".

The decision is made purely from Ashby + Apollo, never from D1: D1 is bookkeeping
here, and an expired wrangler token shouldn't be able to stop (or half-finish) an
archive run. `--mark-only` stamps contacts.archived_at afterwards, reading the
truth back off Ashby, so it is safe to run late, twice, or never.

Safety rails:
  * only touches applications currently in the Reached Out stage, so anything a
    human advanced, or that is already archived, is left alone
  * skips anyone still in a mapped Apollo sequence
  * skips anyone Apollo has ever recorded a reply from, even if the sync missed it
  * idempotent — re-running only picks up what is still unarchived

Usage:
    python3 scripts/archive_pruned.py --dry-run
    python3 scripts/archive_pruned.py --limit 1
    python3 scripts/archive_pruned.py
    python3 scripts/archive_pruned.py --mark-only   # needs an interactive shell
"""

import argparse
import base64
import csv
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARCHIVED_STAGE_ID = "00000000-0000-0000-0000-000000000055"
ARCHIVE_REASON_ID = "00000000-0000-0000-0000-000000000056"  # Did Not Respond to Outreach
REACHED_OUT_STAGE = "Reached Out"
JOB_ID = "00000000-0000-0000-0000-000000000057"
# The mapped Apollo sequences feeding that job (mirrors D1 sequence_job_map). Kept
# here so an archive run doesn't depend on a live wrangler session.
SEQUENCE_IDS = ["000000000000000000000058", "000000000000000000000059"]
# Cloudflare (in front of both APIs) 403s the default python-urllib User-Agent.
UA = "curl/8.4"


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


def ashby(method: str, body: dict, key: str) -> dict:
    auth = base64.b64encode(f"{key}:".encode()).decode()
    return post(
        f"https://api.ashbyhq.com/{method}",
        body,
        {"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
    )


def apollo(path: str, body: dict, key: str) -> dict:
    return post(
        f"https://api.apollo.io/api/v1/{path}",
        body,
        {"Content-Type": "application/json", "x-api-key": key},
    )


def d1(sql: str) -> list:
    """Run SQL against the remote D1 database, retrying the flaky 7403 auth error.

    Needs an interactive shell: wrangler's OAuth login is refused in a non-interactive
    environment unless CLOUDFLARE_API_TOKEN is set. That is why the archive loop never
    touches D1 mid-run — see --mark-only.
    """
    for attempt in range(4):
        proc = subprocess.run(
            ["npx", "wrangler", "d1", "execute", "apollo-ashby-sync",
             "--remote", "--json", "--command", sql],
            cwd=ROOT, capture_output=True, text=True,
        )
        try:
            parsed = json.loads(proc.stdout)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list):
            return parsed[-1].get("results", [])
        time.sleep(2 ** attempt)
    sys.exit(f"D1 query failed: {proc.stdout[:400]}{proc.stderr[:400]}")


def sequence_membership(apollo_key: str, sequence_ids: list) -> set:
    """Emails currently sitting in any mapped Apollo sequence.

    Apollo's pagination is not stable across calls, so each sequence is walked
    repeatedly and unioned until a full pass turns up nothing new.
    """
    emails = set()
    for sid in sequence_ids:
        for _ in range(4):
            before = len(emails)
            page = 1
            while page <= 30:
                data = apollo("contacts/search",
                              {"per_page": 100, "page": page, "emailer_campaign_ids": [sid]},
                              apollo_key)
                contacts = data.get("contacts", [])
                if not contacts:
                    break
                for c in contacts:
                    if c.get("email"):
                        emails.add(c["email"].lower())
                pagination = data.get("pagination") or {}
                if page >= (pagination.get("total_pages") or 1):
                    break
                page += 1
                time.sleep(0.2)
            if len(emails) == before:
                break
    return emails


def emailed_since(apollo_key: str, cutoff_iso: str, pages: int = 10) -> set:
    """Addresses Apollo has emailed since `cutoff_iso`.

    Only used with --membership-cache, to close the gap between when the cache was
    taken and now: anyone Apollo has emailed since is still in a sequence. The
    cutoff matters — a contact emailed *before* the snapshot and pruned afterwards
    is legitimately archivable, so widening this window would wrongly protect them.

    emailer_messages/search comes back newest-first, so this stops at the cutoff.
    """
    seen, page = set(), 1
    while page <= pages:
        data = apollo("emailer_messages/search", {"per_page": 100, "page": page}, apollo_key)
        msgs = data.get("emailer_messages", [])
        if not msgs:
            break
        for m in msgs:
            sent = m.get("completed_at")
            if sent and sent < cutoff_iso:
                return seen
            if m.get("to_email"):
                seen.add(m["to_email"].lower())
        page += 1
        time.sleep(0.2)
    return seen


def everyone_who_replied(apollo_key: str) -> set:
    """Emails Apollo has ever flagged a reply from, read off the sent messages.

    Sequence membership alone is not enough: a contact who replied but whose
    webhook dropped, and who was then pruned out of the sequence, is invisible to
    contacts/search and would look exactly like a non-responder. Message records
    survive the pruning, so this is the backstop that keeps us from archiving a
    live conversation as "Did Not Respond to Outreach".
    """
    replied, page = set(), 1
    while page <= 60:
        data = apollo("emailer_messages/search", {"per_page": 100, "page": page}, apollo_key)
        msgs = data.get("emailer_messages", [])
        if not msgs:
            break
        for m in msgs:
            if m.get("replied") and m.get("to_email"):
                replied.add(m["to_email"].lower())
        page += 1
        time.sleep(0.2)
    return replied


def reached_out_leads(ashby_key: str) -> list:
    """Every application on the job currently in Reached Out, with its email.

    application.list omits candidate emails, so the addresses come from
    candidate.list and are joined on the candidate's applicationIds.
    """
    apps, cursor = {}, None
    while True:
        body = {"jobId": JOB_ID, "limit": 100}
        if cursor:
            body["cursor"] = cursor
        data = ashby("application.list", body, ashby_key)
        for app in data.get("results", []):
            stage = (app.get("currentInterviewStage") or {}).get("title")
            if stage == REACHED_OUT_STAGE:
                apps[app["id"]] = None
        if not data.get("moreDataAvailable"):
            break
        cursor = data.get("nextCursor")

    cursor = None
    while True:
        body = {"limit": 100}
        if cursor:
            body["cursor"] = cursor
        data = ashby("candidate.list", body, ashby_key)
        for cand in data.get("results", []):
            email = (cand.get("primaryEmailAddress") or {}).get("value")
            if not email:
                emails = cand.get("emailAddresses") or []
                email = emails[0].get("value") if emails else None
            if not email:
                continue
            for app_id in cand.get("applicationIds") or []:
                if app_id in apps:
                    apps[app_id] = {"email": email.lower(),
                                    "name": cand.get("name") or "",
                                    "candidate_id": cand.get("id") or ""}
        if not data.get("moreDataAvailable"):
            break
        cursor = data.get("nextCursor")

    return [{**info, "ashby_application_id": a} for a, info in apps.items() if info]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--limit", type=int, help="archive at most N applications")
    ap.add_argument("--csv", metavar="PATH",
                    help="write the list of leads to archive to a CSV and stop")
    ap.add_argument("--membership-cache", metavar="PATH",
                    help="JSON array of sequence-member emails, for when Apollo's "
                         "contacts/search daily cap is spent (see recently_emailed)")
    ap.add_argument("--mark-only", action="store_true",
                    help="skip archiving; just sync contacts.archived_at from Ashby "
                         "(run this after an archive pass, from an interactive shell)")
    args = ap.parse_args()

    ashby_key, apollo_key = secret("ASHBY_API_KEY"), secret("APOLLO_MASTER_KEY")

    if args.mark_only:
        mark_only(ashby_key)
        return

    print(f"mapped Apollo sequences: {len(SEQUENCE_IDS)}")

    if args.membership_cache:
        # contacts/search is capped at 2000 calls/day and a bulk job can exhaust it.
        # Fall back to a saved membership list, widened by whoever Apollo has emailed
        # since, so a stale cache can never archive someone still in a sequence.
        cache_path = Path(args.membership_cache)
        cached = {e.lower() for e in json.loads(cache_path.read_text())}
        cutoff = datetime.fromtimestamp(cache_path.stat().st_mtime, timezone.utc).isoformat()
        fresh = emailed_since(apollo_key, cutoff)
        in_sequence = cached | fresh
        print(f"membership from cache: {len(cached)} + {len(fresh)} emailed since "
              f"{cutoff[:19]}Z = {len(in_sequence)}")
    else:
        in_sequence = sequence_membership(apollo_key, SEQUENCE_IDS)
        print(f"contacts still in a mapped sequence: {len(in_sequence)}")
    if not in_sequence:
        sys.exit("refusing to run: Apollo returned no sequence members (would archive everyone)")

    replied = everyone_who_replied(apollo_key)
    print(f"contacts Apollo has ever recorded a reply from: {len(replied)}")

    rows = reached_out_leads(ashby_key)
    print(f"applications sitting in {REACHED_OUT_STAGE}: {len(rows)}")

    targets, skipped = [], {"still in sequence": 0, "replied in Apollo": 0}
    for row in rows:
        email = row["email"]
        if email in in_sequence:
            skipped["still in sequence"] += 1
            continue
        if email in replied:
            # The sync missed this reply. Archiving them would bury a live thread —
            # leave them for the reconciler to move into Replied instead.
            skipped["replied in Apollo"] += 1
            continue
        targets.append(row)

    print(f"\nto archive: {len(targets)}")
    for reason, n in skipped.items():
        print(f"  skipped, {reason}: {n}")

    if args.csv:
        path = Path(args.csv).expanduser()
        with path.open("w", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["email", "name", "ashby_candidate_url",
                             "ashby_candidate_id", "ashby_application_id"])
            for row in targets:
                writer.writerow([row["email"], row.get("name", ""),
                                 f"https://app.ashbyhq.com/candidates/{row.get('candidate_id','')}",
                                 row.get("candidate_id", ""), row["ashby_application_id"]])
        print(f"\nwrote {len(targets)} rows to {path}")
        return

    if args.limit:
        targets = targets[: args.limit]
        print(f"  (limited to {len(targets)} this run)")
    if args.dry_run or not targets:
        print("\ndry run — nothing written" if args.dry_run else "\nnothing to do")
        return

    # Ashby only in this loop. D1 bookkeeping happens in --mark-only, which reads the
    # truth back off Ashby — so a wrangler hiccup can never halt the archiving, and an
    # interrupted run is picked up correctly by the next one.
    done, failed = [], []
    for i, row in enumerate(targets, 1):
        try:
            ashby("application.changeStage",
                  {"applicationId": row["ashby_application_id"],
                   "interviewStageId": ARCHIVED_STAGE_ID,
                   "archiveReasonId": ARCHIVE_REASON_ID},
                  ashby_key)
            done.append(row)
        except Exception as err:  # keep going; a single bad row shouldn't stop the run
            failed.append((row["email"], str(err)[:160]))
        if i % 50 == 0 or i == len(targets):
            print(f"  {i}/{len(targets)} archived={len(done)} failed={len(failed)}", flush=True)
        time.sleep(0.05)

    if failed:
        print(f"\n{len(failed)} failures:")
        for email, err in failed[:10]:
            print(f"  {email}: {err}")
    print(f"\narchived {len(done)} in Ashby — now run: python3 {Path(__file__).name} --mark-only")


def mark_only(ashby_key: str) -> None:
    """Stamp contacts.archived_at from Ashby's actual state. Idempotent."""
    archived, cursor = [], None
    while True:
        body = {"jobId": JOB_ID, "limit": 100}
        if cursor:
            body["cursor"] = cursor
        data = ashby("application.list", body, ashby_key)
        for app in data.get("results", []):
            if app.get("status") == "Archived":
                archived.append(app["id"])
        if not data.get("moreDataAvailable"):
            break
        cursor = data.get("nextCursor")
    print(f"archived applications in Ashby: {len(archived)}")

    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    updated = 0
    for i in range(0, len(archived), 200):  # keep each SQL statement a sane length
        chunk = archived[i:i + 200]
        ids = ",".join("'" + a + "'" for a in chunk)
        d1(f"UPDATE contacts SET archived_at = '{now}' "
           f"WHERE archived_at IS NULL AND ashby_application_id IN ({ids});")
        updated += len(chunk)
        print(f"  marked {min(updated, len(archived))}/{len(archived)}", flush=True)
    rows = d1("SELECT COUNT(*) AS n FROM contacts WHERE archived_at IS NOT NULL;")
    print(f"D1 rows with archived_at: {rows[0]['n']}")


if __name__ == "__main__":
    main()
