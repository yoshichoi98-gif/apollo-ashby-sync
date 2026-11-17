// Cron reconciler: make Ashby match Apollo, whatever the webhooks did.
//
// Both webhooks are one-shot. If Apollo's Workflow never enrolls a contact, or the
// POST is dropped, that event is lost forever:
//   * a missed "replied" leaves someone parked in "Reached Out" while they wait on
//     a human;
//   * a missed "added" leaves them out of Ashby entirely.
// Both happened in production.
//
// Apollo records both states on its own (sends show up as completed messages, and
// a reply flags the message), so polling that and re-driving the same writes makes
// the sync self-healing. The webhooks stay the fast path.
//
// The cron pass (reconcileFromMessages) reads ONLY emailer_messages. Never put
// contacts/search back on the cron: walking every sequence's members spent Apollo's
// 2000/day within hours, and the add webhook needs that same budget to route each new
// contact, so new contacts were left out of Ashby until the limit reset.

import type { Env } from "./env.js";
import { fetchSequenceContacts, hasBeenEmailed, fetchRecentMessages } from "./apollo.js";
import { moveToReplied, ensureLead } from "./sync.js";
import * as db from "./db.js";

/**
 * Most hasBeenEmailed lookups the manual full pass will spend. Each one is an
 * emailer_messages call against Apollo's 2000/day, which the hourly message
 * download also draws on. Whatever is deferred is logged, never silently dropped.
 */
const MAX_BACKFILL_PER_RUN = 25;

/**
 * Most leads the cron pass will create in one run. They cost no Apollo call, only
 * ~3-4 Ashby calls each, so the cap is about keeping one run's Ashby writes and
 * subrequests sane. A backlog drains over the following hours.
 */
const MAX_LISTED_BACKFILL_PER_RUN = 150;

/**
 * The cron pass: one download of Apollo's newest sent messages drives both halves.
 *   * Backfill: anyone sent a mapped sequence's email with no row here gets their
 *     lead. Their add webhook never landed, or its routing lookup was refused.
 *   * Replies: deepReplyScan over the same download's reply flags.
 * Coverage is as far back as the download reaches (as far back as maxPages reaches); the
 * manual full pass (reconcileReplies) walks whole sequences if ever needed.
 */
export async function reconcileFromMessages(env: Env): Promise<ReconcileReport> {
  const report = emptyReport();
  const recent = await fetchRecentMessages(env.APOLLO_MASTER_KEY);
  report.contactsSeen = recent.sent.size;

  const routes = new Set(
    (await db.listRoutes(env.DB)).map((r) => r.sequence_id).filter(isApolloSequenceId),
  );
  report.sequences = routes.size;

  // Lowercased: message to_email and the webhook's stored email can differ in case.
  const known = new Set<string>();
  for (const r of await db.listContacts(env.DB)) {
    if (r.email) known.add(r.email.toLowerCase());
    known.add(r.apollo_contact_id);
  }

  let attempts = 0;
  for (const s of recent.sent.values()) {
    if (known.has(s.email) || known.has(s.contactId)) continue;
    const sequenceId = s.sequenceIds.find((id) => routes.has(id));
    if (!sequenceId) continue;
    if (attempts >= MAX_LISTED_BACKFILL_PER_RUN) {
      report.deferred++;
      continue;
    }
    attempts++;
    try {
      const result = await ensureLead(
        env,
        { contactId: s.contactId, email: s.email, name: s.name },
        sequenceId,
      );
      if (result.status === "created") {
        report.created.push(s.email);
        console.log(`[reconcile] backfilled missed add for ${s.email}: ${result.detail}`);
      }
    } catch (err) {
      report.errors.push(`${s.email}: ${msg(err)}`);
    }
  }

  const deep = await deepReplyScan(env, recent.replied);
  report.repliersSeen = deep.repliersSeen;
  report.moved = deep.moved;
  report.errors.push(...deep.errors);

  console.log(
    `[reconcile] ${report.contactsSeen} recently emailed across ${report.sequences} mapped sequence(s), ` +
      `${report.created.length} lead(s) created, ${report.deferred} deferred to next run, ` +
      `${report.moved.length} reply recovered, ${report.errors.length} error(s)`,
  );
  return report;
}

export interface ReconcileReport {
  sequences: number;
  contactsSeen: number;
  repliersSeen: number;
  moved: string[];
  created: string[];
  deferred: number;
  notYetEmailed: number;
  errors: string[];
}

/** A real Apollo sequence id, not one of the hand-written route keys. */
function isApolloSequenceId(id: string): boolean {
  return /^[0-9a-f]{24}$/i.test(id);
}

/**
 * Catch replies from contacts who are no longer in any sequence.
 *
 * reconcileReplies() walks sequence membership, so a contact pruned out of a
 * sequence after replying is invisible to it — and worse, looks like a
 * non-responder to the archiver. This sweeps Apollo's message-level reply flags
 * instead, which survive pruning, and moves anyone we have a row for.
 */
export async function deepReplyScan(env: Env, replied?: Set<string>): Promise<ReconcileReport> {
  const report = emptyReport();
  replied ??= (await fetchRecentMessages(env.APOLLO_MASTER_KEY)).replied;
  report.repliersSeen = replied.size;

  const routes = await db.listRoutes(env.DB);
  for (const email of replied) {
    try {
      const row = await db.getContactByEmail(env.DB, email);
      if (!row || row.replied_at || !row.ashby_application_id) continue;

      // Only ever use the route recorded at add time. Falling back to "any route"
      // would move them into some other job's Replied stage once a second job exists.
      const route = row.sequence_id
        ? routes.find((r) => r.sequence_id === row.sequence_id)
        : undefined;
      if (!route?.replied_stage_id) {
        report.errors.push(`${email}: no replied stage mapped for route ${row.sequence_id}`);
        continue;
      }
      const result = await moveToReplied(env, row, route.replied_stage_id, new Date().toISOString());
      if (result.status === "moved") {
        report.moved.push(email);
        console.log(`[deep-scan] recovered out-of-sequence reply for ${email}: ${result.detail}`);
      }
    } catch (err) {
      report.errors.push(`${email}: ${msg(err)}`);
    }
  }

  console.log(
    `[deep-scan] ${report.repliersSeen} replier(s) known to Apollo, ` +
      `${report.moved.length} recovered, ${report.errors.length} error(s)`,
  );
  return report;
}

function emptyReport(): ReconcileReport {
  return {
    sequences: 0,
    contactsSeen: 0,
    repliersSeen: 0,
    moved: [],
    created: [],
    deferred: 0,
    notYetEmailed: 0,
    errors: [],
  };
}

/**
 * Manual full pass (GET /admin/reconcile?full=1), NOT on the cron: walks every
 * mapped sequence's members via contacts/search (many pages), which
 * is the budget the add webhook routes with. Reaches people emailed too long ago
 * for the cron's message download.
 */
export async function reconcileReplies(env: Env): Promise<ReconcileReport> {
  const report = emptyReport();
  const budget = { lookups: 0 };

  const routes = (await db.listRoutes(env.DB)).filter((r) => isApolloSequenceId(r.sequence_id));
  report.sequences = routes.length;

  // Same answers as getContactByEmail / getContactById (exact match, newest add
  // wins), from one query instead of two per contact.
  const byEmail = new Map<string, db.ContactRow>();
  const byId = new Map<string, db.ContactRow>();
  for (const r of await db.listContacts(env.DB)) {
    if (r.email) byEmail.set(r.email, r);
    byId.set(r.apollo_contact_id, r);
  }

  for (const route of routes) {
    let contacts;
    try {
      contacts = await fetchSequenceContacts(env.APOLLO_MASTER_KEY, route.sequence_id);
    } catch (err) {
      report.errors.push(`fetch ${route.sequence_id}: ${msg(err)}`);
      continue;
    }
    report.contactsSeen += contacts.length;

    for (const c of contacts) {
      try {
        // The webhook path keys contacts by "email:<addr>", so look both ways.
        const row = byEmail.get(c.email) ?? byId.get(c.contactId);

        if (!row) {
          await backfillLead(env, c, route.sequence_id, report, budget);
          continue;
        }
        if (!c.replied) continue;
        report.repliersSeen++;
        if (row.replied_at || !row.ashby_application_id) continue;

        const result = await moveToReplied(
          env,
          row,
          route.replied_stage_id,
          c.repliedAt ?? new Date().toISOString(),
        );
        if (result.status === "moved") {
          report.moved.push(c.email);
          console.log(`[reconcile] recovered missed reply for ${c.email}: ${result.detail}`);
        }
      } catch (err) {
        report.errors.push(`${c.email}: ${msg(err)}`);
      }
    }
  }

  console.log(
    `[reconcile] ${report.sequences} sequence(s), ${report.contactsSeen} contact(s), ` +
      `${report.moved.length} reply recovered, ${report.created.length} lead(s) created, ` +
      `${report.deferred} deferred to next run, ${report.notYetEmailed} not yet emailed, ` +
      `${report.errors.length} error(s)`,
  );
  return report;
}

/**
 * A contact is in a mapped sequence but has no row here, so the "added" webhook
 * never landed. Create the lead — but only once Apollo has actually sent them
 * something, matching the "finished step 1" trigger the webhook fires on.
 */
async function backfillLead(
  env: Env,
  c: {
    email: string;
    contactId: string;
    name?: string;
    lastActivityAt: string | null;
    linkedinUrl: string | null;
  },
  sequenceId: string,
  report: ReconcileReport,
  budget: { lookups: number },
): Promise<void> {
  // Cheap pre-filter: no activity at all means Apollo has not emailed them, so
  // there is no need to spend a message lookup finding that out.
  if (!c.lastActivityAt) {
    report.notYetEmailed++;
    return;
  }
  // Capped on lookups spent, not leads created: a contact with activity but no
  // send yet costs a call every run without ever counting as created.
  if (budget.lookups >= MAX_BACKFILL_PER_RUN) {
    report.deferred++;
    return;
  }
  budget.lookups++;
  if (!(await hasBeenEmailed(env.APOLLO_MASTER_KEY, c.email))) {
    report.notYetEmailed++;
    return;
  }

  const result = await ensureLead(
    env,
    {
      contactId: c.contactId,
      email: c.email,
      name: c.name,
      linkedinUrl: c.linkedinUrl ?? undefined,
    },
    sequenceId,
  );
  if (result.status === "created") {
    report.created.push(c.email);
    console.log(`[reconcile] backfilled missed add for ${c.email}: ${result.detail}`);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
