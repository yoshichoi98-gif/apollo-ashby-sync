# Apollo → Ashby Recruiting Sync

Connects our candidate outreach tool (Apollo) to our applicant tracking system (Ashby). When a candidate is added to an outreach sequence, they appear in Ashby under the right job. When they reply, their application moves forward automatically.

## Why I built it

We sourced candidates through email sequences in Apollo, but the hiring team worked in Ashby. Every candidate and every reply had to be copied over by hand, and replies were sometimes missed, leaving real people waiting.

## What it does

- **Added to a sequence:** the candidate is created in Ashby (deduplicated by email) and placed in the Lead stage of the matching job.
- **Replied:** their application moves to the Replied stage.
- **Routing table:** each sequence maps to a job and stage in a small database table that can be edited without a redeploy.
- **Cleanup script:** `scripts/archive_pruned.py` archives leads who were removed from outreach, with a `--dry-run` mode.

## How it works

```
Apollo "added to sequence"  --webhook-->  create Ashby candidate + application (Lead)
Apollo "replied"            --webhook-->  move application to Replied
Hourly reconciler           -------------> backfill anything the webhooks missed
```

## Engineering decisions

- **Webhooks for speed, a reconciler as the net.** Webhooks are one-shot: if one is dropped, that reply is lost. That happened once, so I added an hourly job that compares Apollo's sent and replied mail against what's in Ashby and fixes any gaps.
- **Designed around API limits.** An earlier version of the reconciler looked up every sequence's members and used up Apollo's daily search limit in about 10 hours, which blocked new candidates. The current version downloads recent sent mail in one pass (about 1,440 of the 2,000 daily calls) and uses zero searches, leaving those for the real-time path.
- **Never moves people backwards.** The sync only touches applications still in a Lead stage, so a late reply can't drag someone out of an interview stage or un-archive them.
- **Idempotent.** A D1 table records every candidate it has handled, so retries and duplicate webhooks are harmless.
- **API quirks written down.** The Apollo endpoints that silently ignore filters, unstable pagination and hourly caps are documented in the code where they matter.

## Stack

TypeScript, Cloudflare Workers (webhooks + cron + D1), Apollo API, Ashby API, Python for maintenance scripts.

## Layout

- `src/index.ts`: routes and cron entry, token check
- `src/sync.ts`: add and reply handling
- `src/reconcile.ts`: the hourly reconciler
- `src/apollo.ts`, `src/ashby.ts`: API clients (with backoff on rate limits)
- `src/db.ts`, `schema.sql`: contact map and routing table
- `scripts/`: archive and LinkedIn backfill scripts

## Running it

`npm install`, create the D1 database with `npx wrangler d1 create apollo-ashby-sync`, run `npm run db:init:remote`, set secrets with `npx wrangler secret put <NAME>`, then `npm run deploy`. Point two Apollo Workflows ("contact added to sequence" and "email replied") at `/apollo/added` and `/apollo/replied`.

---

Built at Alleviate Health. Company names, people, IDs and URLs in this public copy are placeholders.
