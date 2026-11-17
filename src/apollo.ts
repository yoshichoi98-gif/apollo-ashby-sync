// Apollo webhook payload handling.
//
// Apollo's "Send webhook" workflow action lets you build a custom JSON payload from
// merge fields. We can't fully pin the shape until we capture a real delivery (see
// README "Capture the real payload"), so this parser is defensive: it accepts our
// recommended flat shape AND digs through common nested/legacy key names.
//
// Recommended payload to configure in the Apollo workflow (flat, lowercase):
//   {
//     "contact_id":    "{{contact.id}}",
//     "email":         "{{contact.email}}",
//     "first_name":    "{{contact.first_name}}",
//     "last_name":     "{{contact.last_name}}",
//     "sequence_id":   "{{sequence.id}}",       // added-to-sequence workflow only
//     "sequence_name": "{{sequence.name}}"      // added-to-sequence workflow only
//   }

export interface ParsedContact {
  contactId?: string;
  email?: string;
  name?: string;
  sequenceId?: string;
  sequenceName?: string;
  linkedinUrl?: string;
}

/** True if a value is an unresolved Apollo merge tag like "{{contact.id}}". */
function isUnresolved(v: string): boolean {
  return v.includes("{{") && v.includes("}}");
}

/** Walk a few likely locations for a string field; returns first non-empty. */
function pick(obj: any, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() && !isUnresolved(v)) return v.trim();
    if (typeof v === "number") return String(v);
  }
  // one level of nesting under common containers
  for (const container of ["contact", "person", "data", "record"]) {
    const nested = obj[container];
    if (nested && typeof nested === "object") {
      const found = pick(nested, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function buildName(payload: any): string | undefined {
  const full = pick(payload, ["name", "full_name"]);
  if (full) return full;
  const first = pick(payload, ["first_name", "firstName"]);
  const last = pick(payload, ["last_name", "lastName"]);
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || undefined;
}

/** Parse either webhook body into a normalized contact. */
export function parseContact(payload: any): ParsedContact {
  return {
    contactId: pick(payload, ["contact_id", "contactId", "id", "apollo_contact_id"]),
    email: pick(payload, ["email", "email_address", "contact_email"]),
    name: buildName(payload),
    sequenceId: pick(payload, [
      "sequence_id",
      "sequenceId",
      "emailer_campaign_id",
      "campaign_id",
    ]),
    sequenceName: pick(payload, ["sequence_name", "sequenceName", "campaign_name"]),
    linkedinUrl: normalizeLinkedInUrl(
      pick(payload, ["linkedin_url", "linkedinUrl", "linkedin"]),
    ) ?? undefined,
  };
}

/**
 * Clean an Apollo LinkedIn URL into something Ashby will accept as `linkedInUrl`
 * ("Must be a valid Url"), or null if it isn't a profile URL at all.
 *
 * Apollo stores these as `http://www.linkedin.com/in/<slug>` — http, no trailing
 * slash — so we upgrade the scheme and drop any tracking query string. The path is
 * left byte-for-byte otherwise: Apollo lowercases what it stores, and while that is
 * harmless for vanity slugs it would break an `/in/ACwAA…` opaque token, so there is
 * nothing to gain by rewriting case here.
 */
export function normalizeLinkedInUrl(raw?: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || isUnresolved(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  // Only personal profiles — a company page on a candidate is worse than nothing.
  if (!/^\/in\//i.test(url.pathname)) return null;

  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `https://${url.hostname}${path}`;
}

// ---------------------------------------------------------------------------
// Apollo REST helpers (require an Apollo master key).
// ---------------------------------------------------------------------------

const APOLLO_BASE = "https://api.apollo.io/api/v1";

export interface OutboundEmail {
  id: string;
  subject: string;
  from: string;
  to: string;
  bodyHtml: string;
  sentAt: string;
  threadId?: string;
  messageIdHeader?: string;
}

/** Resolve an Apollo contact id from an email. */
export async function lookupContactIdByEmail(
  masterKey: string | undefined,
  email: string,
): Promise<string | null> {
  if (!masterKey || !email) return null;
  try {
    const res = await fetch(`${APOLLO_BASE}/contacts/search`, {
      method: "POST",
      headers: { "x-api-key": masterKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ q_keywords: email, per_page: 1 }),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return (json?.contacts ?? [])[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the outbound sequence emails actually SENT to a contact (skips
 * drafts/scheduled/failed — only messages with a completed_at). Bodies come from
 * Apollo; the candidate's inbound replies are NOT available via this API.
 *
 * Scoping is via `q_keywords` on the address: emailer_messages/search SILENTLY
 * IGNORES a `contact_ids` filter and returns the whole workspace's recent mail,
 * so the results are also re-checked against the contact id below. Getting this
 * wrong attaches other candidates' emails to this candidate in Ashby.
 */
export async function fetchOutboundEmails(
  masterKey: string | undefined,
  contactId: string,
  email: string,
): Promise<OutboundEmail[]> {
  if (!masterKey || !email) return [];
  try {
    const res = await fetch(`${APOLLO_BASE}/emailer_messages/search`, {
      method: "POST",
      headers: { "x-api-key": masterKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ q_keywords: email, per_page: 25 }),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const msgs: any[] = json?.emailer_messages ?? [];
    const out: OutboundEmail[] = [];
    const lower = email.toLowerCase();
    for (const m of msgs) {
      // Belt and braces: never mirror a message that isn't addressed to this contact.
      const matches =
        String(m.contact_id ?? "") === contactId ||
        String(m.to_email ?? "").toLowerCase() === lower;
      if (!matches) continue;
      if (!m.completed_at) continue; // only actually-sent emails
      const bodyHtml = m.body_html || (m.body_text ? `<pre>${escapeHtml(m.body_text)}</pre>` : "");
      if (!bodyHtml) continue;
      out.push({
        id: String(m.id),
        subject: m.subject ?? "(no subject)",
        from: m.from_email ?? "",
        to: m.to_email ?? "",
        bodyHtml,
        sentAt: m.completed_at,
        threadId: m.provider_thread_id ?? m.conversation_id ?? undefined,
        messageIdHeader: m.provider_message_id ?? undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Someone Apollo has actually sent a sequence email to (same bar as hasBeenEmailed). */
export interface RecentSend {
  /** Lowercased to_email. */
  email: string;
  contactId: string;
  name?: string;
  /** Sequences they were sent from, newest send first. */
  sequenceIds: string[];
}

export interface RecentMessages {
  /** Addresses Apollo has flagged a reply from. */
  replied: Set<string>;
  /** Keyed by lowercased address. */
  sent: Map<string, RecentSend>;
}

/**
 * Who Apollo has recently sent to, and who replied, read off the newest sent
 * messages workspace-wide. This is all the cron reads from Apollo.
 *
 * The replied set is the deep scan's backstop. A per-sequence scan misses anyone
 * pruned OUT of a sequence after replying: they vanish from contacts/search while
 * their reply is still real and unhandled. That is how several repliers once sat unmoved for
 * over a week.
 * Message records survive the pruning.
 *
 * The sent map drives backfill: each message names its sequence, so routing a
 * missed add needs no contacts/search call.
 *
 * MUST sort by completed_at: the default order returns only `scheduled` messages,
 * so sent mail (and every reply flag) sits behind the whole send queue, and the deep scan
 * would see no replies at all. maxPages bounds how far back it reaches. Costs one
 * emailer_messages call per page.
 */
export async function fetchRecentMessages(
  masterKey: string | undefined,
  maxPages = 60,
): Promise<RecentMessages> {
  const out: RecentMessages = { replied: new Set(), sent: new Map() };
  if (!masterKey) return out;
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${APOLLO_BASE}/emailer_messages/search`, {
      method: "POST",
      headers: { "x-api-key": masterKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ per_page: 100, page, sort_by_field: "completed_at", sort_ascending: false }),
    });
    if (!res.ok) {
      console.warn(`[reconcile] emailer_messages page ${page}: HTTP ${res.status}`);
      break;
    }
    const json: any = await res.json();
    const msgs: any[] = json?.emailer_messages ?? [];
    if (!msgs.length) break;
    for (const m of msgs) {
      if (!m.to_email) continue;
      const to = String(m.to_email).toLowerCase();
      if (m.replied) out.replied.add(to);
      // Manual one-offs carry no sequence and so no route; skip them.
      if (!m.completed_at || !m.contact_id || !m.emailer_campaign_id) continue;
      let s = out.sent.get(to);
      if (!s) {
        s = { email: to, contactId: String(m.contact_id), name: m.to_name || undefined, sequenceIds: [] };
        out.sent.set(to, s);
      }
      if (!s.sequenceIds.includes(m.emailer_campaign_id)) s.sequenceIds.push(m.emailer_campaign_id);
    }
  }
  return out;
}

/**
 * Has Apollo actually SENT this contact a sequence email yet?
 *
 * The add webhook fires on "finished step 1", i.e. a real send — so the reconciler
 * must apply the same bar before creating a lead, or merely being added to a
 * sequence would put someone in Ashby. Scoped by q_keywords because
 * emailer_messages/search ignores contact filters (see fetchOutboundEmails).
 */
export async function hasBeenEmailed(
  masterKey: string | undefined,
  email: string,
): Promise<boolean> {
  if (!masterKey || !email) return false;
  try {
    const res = await fetch(`${APOLLO_BASE}/emailer_messages/search`, {
      method: "POST",
      headers: { "x-api-key": masterKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ q_keywords: email, per_page: 25 }),
    });
    if (!res.ok) return false;
    const json: any = await res.json();
    const lower = email.toLowerCase();
    return (json?.emailer_messages ?? []).some(
      (m: any) => m.completed_at && String(m.to_email ?? "").toLowerCase() === lower,
    );
  } catch {
    return false;
  }
}

export interface ApolloSequenceContact {
  email: string;
  contactId: string;
  name?: string;
  sequenceId: string;
  replied: boolean;
  repliedAt: string | null;
  /** Null when Apollo has recorded no activity at all — i.e. never emailed yet. */
  lastActivityAt: string | null;
  /** Normalized personal LinkedIn profile URL, if Apollo has one. */
  linkedinUrl: string | null;
}

/**
 * Every contact currently in the given sequence, with the state the reconciler
 * needs: whether Apollo has marked them as replied, and whether anything has
 * happened to them at all.
 *
 * This is the reconciler's source of truth. Apollo sets the campaign status's
 * `inactive_reason` to "replied" (and stamps `finished_at`) as soon as it detects
 * a reply, whether or not the Workflow that POSTs our webhook ever fires — which
 * is what makes a dropped webhook recoverable.
 *
 * Note Apollo's pagination is not stable between calls, so a single pass can miss
 * a page; the cron re-runs often enough that the next pass picks it up.
 */
export async function fetchSequenceContacts(
  masterKey: string | undefined,
  sequenceId: string,
  maxPages = 30,
): Promise<ApolloSequenceContact[]> {
  if (!masterKey) return [];
  const out: ApolloSequenceContact[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${APOLLO_BASE}/contacts/search`, {
      method: "POST",
      headers: { "x-api-key": masterKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ per_page: 100, page, emailer_campaign_ids: [sequenceId] }),
    });
    if (!res.ok) {
      // 429 here means the hourly contacts/search budget is spent; stop cleanly and
      // let the next cron tick continue rather than throwing away the whole run.
      console.warn(`[reconcile] contacts/search page ${page} for ${sequenceId}: HTTP ${res.status}`);
      break;
    }
    const json: any = await res.json();
    const contacts: any[] = json?.contacts ?? [];
    if (!contacts.length) break;
    for (const c of contacts) {
      const email = typeof c.email === "string" ? c.email.toLowerCase() : "";
      if (!email) continue;
      const linkedinUrl = normalizeLinkedInUrl(c.linkedin_url);
      for (const s of c.contact_campaign_statuses ?? []) {
        if (s.emailer_campaign_id !== sequenceId) continue;
        const replied = String(s.inactive_reason ?? "").toLowerCase() === "replied";
        out.push({
          email,
          contactId: String(c.id),
          name: typeof c.name === "string" ? c.name : undefined,
          sequenceId,
          replied,
          repliedAt: replied ? s.finished_at ?? null : null,
          lastActivityAt: c.last_activity_date ?? null,
          linkedinUrl,
        });
      }
    }
    const totalPages = json?.pagination?.total_pages ?? 1;
    if (page >= totalPages) break;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface ApolloContactLookup {
  /** The routing key: the sequence this contact is in, if any. */
  sequenceId: string | null;
  /** Normalized personal LinkedIn profile URL, if Apollo has one. */
  linkedinUrl: string | null;
}

/**
 * Given a contact's email, ask Apollo which sequence they're in and return that
 * sequence id (used as the routing key). This is what lets a SINGLE Apollo
 * workflow serve every job: the Worker derives the sequence from the email.
 *
 * Also returns the contact's LinkedIn URL, which rides along on the same contact
 * record — attaching it to the Ashby candidate costs no extra call, which matters
 * because contacts/search is capped at 400/hour and 2000/day across this Worker.
 *
 * Prefers an active (non-finished) campaign, then the most recently added.
 * Best-effort — returns nulls (never throws) if the key is missing or nothing found.
 */
export async function lookupContactByEmail(
  masterKey: string | undefined,
  email: string,
): Promise<ApolloContactLookup> {
  const empty: ApolloContactLookup = { sequenceId: null, linkedinUrl: null };
  if (!masterKey || !email) return empty;
  try {
    const res = await fetch(`${APOLLO_BASE}/contacts/search`, {
      method: "POST",
      headers: {
        "x-api-key": masterKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ q_keywords: email, per_page: 1 }),
    });
    if (!res.ok) return empty;
    const json: any = await res.json();
    const contact = (json?.contacts ?? [])[0];
    if (!contact) return empty;

    const linkedinUrl = normalizeLinkedInUrl(contact.linkedin_url);

    const statuses: any[] = contact.contact_campaign_statuses ?? [];
    if (statuses.length) {
      // active first, then newest by added_at
      const ranked = [...statuses].sort((a, b) => {
        const aActive = a.status === "active" && !a.finished_at ? 1 : 0;
        const bActive = b.status === "active" && !b.finished_at ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return String(b.added_at ?? "").localeCompare(String(a.added_at ?? ""));
      });
      const seq = ranked[0]?.emailer_campaign_id;
      if (seq) return { sequenceId: seq, linkedinUrl };
    }
    // fallback: last campaign id on the contact
    const ids: string[] = contact.emailer_campaign_ids ?? [];
    return { sequenceId: ids.length ? ids[ids.length - 1] : null, linkedinUrl };
  } catch {
    return empty;
  }
}
