// Core sync logic: turn a parsed Apollo webhook into Ashby writes.

import type { Env } from "./env.js";
import {
  parseContact,
  lookupContactByEmail,
  lookupContactIdByEmail,
  fetchOutboundEmails,
} from "./apollo.js";
import * as ashby from "./ashby.js";
import * as db from "./db.js";

export interface SyncResult {
  status: "created" | "moved" | "noop" | "skipped";
  detail: string;
}

/** Stable D1 key for a contact: prefer Apollo's id, fall back to email. */
function keyFor(contactId?: string, email?: string): string | null {
  if (contactId) return contactId;
  if (email) return `email:${email.toLowerCase()}`;
  return null;
}

/**
 * Handle "contact added to sequence": find/create the Ashby candidate and drop
 * them into the routed job's Lead stage. Idempotent.
 */
export async function handleAdded(env: Env, payload: any, routeKey?: string): Promise<SyncResult> {
  const c = parseContact(payload);

  // Bail before spending an Apollo call if we've already processed this contact.
  // Apollo can re-POST the same add, and the lookup below draws on a quota that the
  // reconciler needs; ensureLead would reach the same conclusion, only later.
  const key = keyFor(c.contactId, c.email);
  if (key) {
    const existing = await db.getContactById(env.DB, key);
    if (existing?.added_at) {
      return { status: "noop", detail: `already added (candidate ${existing.ashby_candidate_id})` };
    }
  }

  // Routing key resolution:
  //  1. URL ?route= (explicit per-job workflow, if ever used)
  //  2. payload sequence_id (if Apollo ever resolves it)
  //  3. Apollo API lookup of the contact's sequence by email — this is what lets
  //     ONE workflow serve every job (the sequence, hence job, is derived here).
  //
  // Step 3 costs one contacts/search call, and that endpoint is capped at 400/hour
  // and 2000/day. When the budget is spent the lookup returns null and the contact
  // would be dropped — so the cron reconciler re-derives routing from sequence data
  // it already holds and creates the lead then. Nothing is lost, only delayed.
  //
  // The same call carries the contact's LinkedIn URL, so we also make it when
  // routing is already known but the payload had no LinkedIn — the webhook's merge
  // fields are email/first_name/last_name only, so in practice that is every add.
  let routing = routeKey ?? c.sequenceId;
  let linkedinUrl = c.linkedinUrl;
  if ((!routing || !linkedinUrl) && c.email) {
    const found = await lookupContactByEmail(env.APOLLO_MASTER_KEY, c.email);
    routing = routing ?? found.sequenceId ?? undefined;
    linkedinUrl = linkedinUrl ?? found.linkedinUrl ?? undefined;
  }

  return ensureLead(env, { ...c, linkedinUrl }, routing);
}

/**
 * Create the Ashby candidate + application for a contact, in the Lead stage their
 * sequence routes to. Idempotent, and safe to call from either the webhook or the
 * reconciler — the only difference between them is how `routing` was derived.
 */
export async function ensureLead(
  env: Env,
  c: { contactId?: string; email?: string; name?: string; linkedinUrl?: string },
  routing?: string,
): Promise<SyncResult> {
  const key = keyFor(c.contactId, c.email);
  if (!key) return { status: "skipped", detail: "payload had neither contact id nor email" };

  // Idempotency: already processed this contact's add.
  const existing = await db.getContactById(env.DB, key);
  if (existing?.added_at) {
    return { status: "noop", detail: `already added (candidate ${existing.ashby_candidate_id})` };
  }

  let jobId: string | undefined;
  let leadStageId: string | undefined;
  if (routing) {
    const route = await db.getRoute(env.DB, routing);
    if (route) {
      jobId = route.ashby_job_id;
      leadStageId = route.lead_stage_id ?? undefined;
    }
  }
  if (!jobId && env.DEFAULT_JOB_ID) jobId = env.DEFAULT_JOB_ID;
  if (!jobId) {
    return {
      status: "skipped",
      detail: `no route for "${routing ?? "(unknown)"}" and no DEFAULT_JOB_ID`,
    };
  }

  // Find or create the candidate (dedupe by email).
  let candidate = c.email ? await ashby.searchCandidate(env.ASHBY_API_KEY, c.email) : null;
  let linkedinAttached = false;
  if (candidate) {
    // They already exist in Ashby, so their LinkedIn (if any) belongs to whoever
    // put it there — a recruiter's own entry outranks Apollo's. Only fill a blank.
    if (c.linkedinUrl && !ashby.hasLinkedIn(candidate)) {
      try {
        await ashby.updateCandidate(env.ASHBY_API_KEY, {
          candidateId: candidate.id,
          linkedInUrl: c.linkedinUrl,
        });
        linkedinAttached = true;
      } catch (err) {
        // Never let a cosmetic field block the lead itself from being created.
        console.error(`[linkedin] patch failed for ${candidate.id}: ${msg(err)}`);
      }
    }

    // The candidate already exists, so they may already be on this job — that
    // happens when the D1 row is missing but Ashby is fine (the reconciler's
    // backfill path). Adopt the existing application instead of creating a
    // duplicate on the same job.
    const existingApp = await ashby.findApplicationForJob(env.ASHBY_API_KEY, candidate.id, jobId);
    if (existingApp) {
      await db.recordAdded(env.DB, {
        apolloContactId: key,
        email: c.email ?? null,
        candidateId: candidate.id,
        applicationId: existingApp.id,
        sequenceId: routing ?? null,
        addedAt: new Date().toISOString(),
        linkedinUrl: linkedinAttached || ashby.hasLinkedIn(candidate) ? c.linkedinUrl ?? null : null,
      });
      return {
        status: "noop",
        detail: `candidate ${candidate.id} already had application ${existingApp.id} on job ${jobId}; adopted it`,
      };
    }
  } else {
    const name = c.name || c.email || "Unknown Apollo Contact";
    const base = {
      name,
      email: c.email,
      sourceId: env.ASHBY_SOURCE_ID || undefined,
    };
    try {
      candidate = await ashby.createCandidate(env.ASHBY_API_KEY, {
        ...base,
        linkedInUrl: c.linkedinUrl,
      });
      linkedinAttached = !!c.linkedinUrl;
    } catch (err) {
      // A rejected LinkedIn URL must not cost us the lead. Retry clean, so the
      // candidate still lands in the pipeline with everything else intact.
      if (!c.linkedinUrl) throw err;
      console.error(`[linkedin] create with LinkedIn failed for ${c.email}, retrying without: ${msg(err)}`);
      candidate = await ashby.createCandidate(env.ASHBY_API_KEY, base);
    }
  }

  // Attach to the job (lands in the Lead stage).
  const application = await ashby.createApplication(env.ASHBY_API_KEY, {
    candidateId: candidate.id,
    jobId,
    interviewStageId: leadStageId,
    sourceId: env.ASHBY_SOURCE_ID || undefined,
  });

  await db.recordAdded(env.DB, {
    apolloContactId: key,
    email: c.email ?? null,
    candidateId: candidate.id,
    applicationId: application.id,
    sequenceId: routing ?? null,
    addedAt: new Date().toISOString(),
    linkedinUrl: linkedinAttached ? c.linkedinUrl ?? null : null,
  });

  return {
    status: "created",
    detail:
      `candidate ${candidate.id} -> job ${jobId} (application ${application.id})` +
      (linkedinAttached ? ` with LinkedIn` : ""),
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Handle "email replied": move the contact's Ashby application to the routed
 * replied stage. Idempotent; skips if we never saw the add or have no route.
 */
export async function handleReplied(env: Env, payload: any, routeKey?: string): Promise<SyncResult> {
  const c = parseContact(payload);
  const key = keyFor(c.contactId, c.email);
  if (!key) return { status: "skipped", detail: "payload had neither contact id nor email" };

  let row = await db.getContactById(env.DB, key);
  if (!row && c.email) row = await db.getContactByEmail(env.DB, c.email);
  if (!row) return { status: "skipped", detail: "reply for a contact we never added" };
  if (row.replied_at) return { status: "noop", detail: "already moved to replied stage" };
  if (!row.ashby_application_id) {
    return { status: "skipped", detail: "no Ashby application recorded for this contact" };
  }

  // Resolve the replied stage: prefer the route stored at add-time, else the URL's ?route=.
  const routing = row.sequence_id ?? routeKey;
  if (!routing) {
    return { status: "skipped", detail: "no route recorded, cannot resolve replied stage" };
  }
  const route = await db.getRoute(env.DB, routing);
  if (!route?.replied_stage_id) {
    return { status: "skipped", detail: `no replied stage mapped for route ${routing}` };
  }

  return moveToReplied(env, row, route.replied_stage_id, new Date().toISOString());
}

/**
 * Move one already-synced contact into their job's Replied stage and mirror the
 * outbound emails. Shared by the webhook path and the cron reconciler, so both
 * behave identically and both are safe to call twice.
 *
 * Only ever moves an application that is still sitting in a Lead-type stage: once
 * a human has advanced someone to a later interview stage (or archived them), a late reply
 * event must not drag them backwards.
 */
export async function moveToReplied(
  env: Env,
  row: db.ContactRow,
  repliedStageId: string,
  repliedAt: string,
): Promise<SyncResult> {
  const applicationId = row.ashby_application_id!;
  const current = await ashby.getApplication(env.ASHBY_API_KEY, applicationId);
  const stage = current.currentInterviewStage;

  if (stage?.id === repliedStageId) {
    // Already there — just record it so we stop reconsidering them.
    await db.markReplied(env.DB, row.apollo_contact_id, repliedAt);
    return { status: "noop", detail: `application ${applicationId} was already in Replied` };
  }
  if (current.status === "Archived" || (stage?.type && stage.type !== "Lead")) {
    await db.markReplied(env.DB, row.apollo_contact_id, repliedAt);
    return {
      status: "skipped",
      detail: `application ${applicationId} is past the lead stages (${current.status}/${stage?.title}); left alone`,
    };
  }

  await ashby.changeStage(env.ASHBY_API_KEY, {
    applicationId,
    interviewStageId: repliedStageId,
  });
  await db.markReplied(env.DB, row.apollo_contact_id, repliedAt);

  // Responder-only: now that they've replied, backfill the outbound emails we sent
  // them into Ashby as email activity (best-effort; never fails the stage move).
  let mirrored = 0;
  if (row.ashby_candidate_id && row.email) {
    try {
      mirrored = await mirrorOutboundEmails(env, row.email, row.ashby_candidate_id);
    } catch (err) {
      console.error(`[mirror] failed for ${row.ashby_candidate_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    status: "moved",
    detail: `application ${applicationId} -> ${repliedStageId}; mirrored ${mirrored} email(s)`,
  };
}

/**
 * Pull the outbound sequence emails Apollo sent this contact and attach each to the
 * Ashby candidate as email activity. Idempotent via Apollo's message id. Returns count.
 */
async function mirrorOutboundEmails(env: Env, email: string, candidateId: string): Promise<number> {
  const contactId = await lookupContactIdByEmail(env.APOLLO_MASTER_KEY, email);
  if (!contactId) return 0;
  const emails = await fetchOutboundEmails(env.APOLLO_MASTER_KEY, contactId, email);
  let n = 0;
  for (const m of emails) {
    if (!m.from || !m.to) continue;
    await ashby.addEmailMessage(env.ASHBY_API_KEY, {
      candidateId,
      emailProviderEmailId: `apollo-${m.id}`,
      subject: m.subject,
      from: m.from,
      to: m.to,
      body: m.bodyHtml,
      sentAt: m.sentAt,
      threadId: m.threadId,
      messageIdHeader: m.messageIdHeader,
    });
    n++;
  }
  return n;
}
