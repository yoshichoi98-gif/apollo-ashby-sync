// D1 helpers: contact mapping (idempotency + reply lookup) and sequence routing.

export interface ContactRow {
  apollo_contact_id: string;
  email: string | null;
  ashby_candidate_id: string | null;
  ashby_application_id: string | null;
  sequence_id: string | null;
  added_at: string | null;
  replied_at: string | null;
  /** Set once we've actually written a LinkedIn URL onto the Ashby candidate. */
  linkedin_url: string | null;
}

export interface SequenceRoute {
  sequence_id: string;
  sequence_name: string | null;
  ashby_job_id: string;
  lead_stage_id: string | null;
  replied_stage_id: string;
}

export async function getContactById(
  db: D1Database,
  apolloContactId: string,
): Promise<ContactRow | null> {
  return db
    .prepare("SELECT * FROM contacts WHERE apollo_contact_id = ?")
    .bind(apolloContactId)
    .first<ContactRow>();
}

export async function getContactByEmail(
  db: D1Database,
  email: string,
): Promise<ContactRow | null> {
  return db
    .prepare("SELECT * FROM contacts WHERE email = ? ORDER BY added_at DESC LIMIT 1")
    .bind(email)
    .first<ContactRow>();
}

/**
 * Every contact row, oldest add first. The reconciler indexes this once per run:
 * a query per Apollo contact (thousands a run) blows Cloudflare's 10,000 subrequests
 * per invocation, since D1 calls count toward it.
 */
export async function listContacts(db: D1Database): Promise<ContactRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM contacts ORDER BY added_at ASC")
    .all<ContactRow>();
  return results ?? [];
}

/** Record a newly created Ashby lead. Idempotent via PRIMARY KEY upsert. */
export async function recordAdded(
  db: D1Database,
  row: {
    apolloContactId: string;
    email: string | null;
    candidateId: string;
    applicationId: string;
    sequenceId: string | null;
    addedAt: string;
    linkedinUrl?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO contacts
         (apollo_contact_id, email, ashby_candidate_id, ashby_application_id, sequence_id, added_at, linkedin_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(apollo_contact_id) DO UPDATE SET
         email = excluded.email,
         ashby_candidate_id = excluded.ashby_candidate_id,
         ashby_application_id = excluded.ashby_application_id,
         sequence_id = excluded.sequence_id,
         added_at = excluded.added_at,
         -- Never blank out a LinkedIn we already recorded: a re-run that couldn't
         -- resolve one (spent Apollo quota) shouldn't look like "needs backfill".
         linkedin_url = COALESCE(excluded.linkedin_url, contacts.linkedin_url)`,
    )
    .bind(
      row.apolloContactId,
      row.email,
      row.candidateId,
      row.applicationId,
      row.sequenceId,
      row.addedAt,
      row.linkedinUrl ?? null,
    )
    .run();
}

/** Record that a LinkedIn URL is now on the Ashby candidate. */
export async function markLinkedIn(
  db: D1Database,
  apolloContactId: string,
  linkedinUrl: string,
): Promise<void> {
  await db
    .prepare("UPDATE contacts SET linkedin_url = ? WHERE apollo_contact_id = ?")
    .bind(linkedinUrl, apolloContactId)
    .run();
}

export async function markReplied(
  db: D1Database,
  apolloContactId: string,
  repliedAt: string,
): Promise<void> {
  await db
    .prepare("UPDATE contacts SET replied_at = ? WHERE apollo_contact_id = ?")
    .bind(repliedAt, apolloContactId)
    .run();
}

/** Every mapped Apollo sequence. The reconciler polls each one for repliers. */
export async function listRoutes(db: D1Database): Promise<SequenceRoute[]> {
  const { results } = await db
    .prepare("SELECT * FROM sequence_job_map")
    .all<SequenceRoute>();
  return results ?? [];
}

export async function getRoute(
  db: D1Database,
  sequenceId: string,
): Promise<SequenceRoute | null> {
  return db
    .prepare("SELECT * FROM sequence_job_map WHERE sequence_id = ?")
    .bind(sequenceId)
    .first<SequenceRoute>();
}
