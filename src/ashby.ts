// Ashby API client.
//
// Auth: HTTP Basic with the API key as the username and an empty password
// (`Authorization: Basic base64(API_KEY + ":")`). Every call is POST to
// https://api.ashbyhq.com/<category>.<method> with a JSON body — even reads.
// Responses are shaped { success: boolean, results?: ..., errors?: [...] }.
// Rate limit: 1000 req/min per key -> we retry HTTP 429 with backoff.

const BASE = "https://api.ashbyhq.com";

export interface AshbySocialLink {
  /** "LinkedIn" | "GitHub" | "Twitter" | "Website" | … */
  type: string;
  url: string;
}

export interface AshbyCandidate {
  id: string;
  name?: string;
  primaryEmailAddress?: { value?: string } | null;
  applicationIds?: string[];
  socialLinks?: AshbySocialLink[];
}

/** Does this candidate already have a LinkedIn profile on file? */
export function hasLinkedIn(candidate: AshbyCandidate): boolean {
  return (candidate.socialLinks ?? []).some(
    (l) => l.type === "LinkedIn" && !!l.url,
  );
}

export interface AshbyApplication {
  id: string;
  /** "Lead" | "Active" | "Archived" | "Hired" | … */
  status?: string;
  currentInterviewStage?: { id: string; title?: string; type?: string } | null;
}

export class AshbyError extends Error {
  constructor(
    public method: string,
    public status: number,
    public body: string,
  ) {
    super(`Ashby ${method} failed (${status}): ${body}`);
  }
}

async function call<T>(apiKey: string, method: string, body: unknown): Promise<T> {
  const auth = btoa(`${apiKey}:`);
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });

    // Retry on rate limit / transient server errors with exponential backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 500 * 2 ** (attempt - 1);
      await sleep(waitMs);
      continue;
    }

    const text = await res.text();
    if (!res.ok) throw new AshbyError(method, res.status, text);

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AshbyError(method, res.status, `non-JSON response: ${text}`);
    }
    // Ashby returns HTTP 200 with { success: false, errors } for logical failures.
    if (json && json.success === false) {
      throw new AshbyError(method, res.status, JSON.stringify(json.errors ?? json));
    }
    return json as T;
  }
  throw new AshbyError(method, 0, "exhausted retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find an existing candidate by email. Returns the first exact match, or null. */
export async function searchCandidate(
  apiKey: string,
  email: string,
): Promise<AshbyCandidate | null> {
  const json = await call<{ results?: AshbyCandidate[] }>(
    apiKey,
    "candidate.search",
    { email },
  );
  const results = json.results ?? [];
  const lower = email.toLowerCase();
  const exact = results.find(
    (c) => c.primaryEmailAddress?.value?.toLowerCase() === lower,
  );
  return exact ?? results[0] ?? null;
}

/** Create a new candidate. `name` is required by Ashby. */
export async function createCandidate(
  apiKey: string,
  input: { name: string; email?: string; sourceId?: string; linkedInUrl?: string },
): Promise<AshbyCandidate> {
  const body: Record<string, unknown> = { name: input.name };
  if (input.email) body.email = input.email;
  if (input.sourceId) body.sourceId = input.sourceId;
  // Ashby validates this as a URL and rejects the whole create if it isn't one,
  // so only ever pass a value that normalizeLinkedInUrl() has already vetted.
  if (input.linkedInUrl) body.linkedInUrl = input.linkedInUrl;
  const json = await call<{ results: AshbyCandidate }>(
    apiKey,
    "candidate.create",
    body,
  );
  return json.results;
}

/**
 * Patch fields onto an existing candidate. Ashby leaves out any field you omit, so
 * this only ever touches what is passed — but note that passing `linkedInUrl` for a
 * candidate who already has one REPLACES it, which is why callers check
 * `hasLinkedIn()` first rather than writing blindly over a recruiter's own entry.
 */
export async function updateCandidate(
  apiKey: string,
  input: { candidateId: string; linkedInUrl?: string },
): Promise<AshbyCandidate> {
  const body: Record<string, unknown> = { candidateId: input.candidateId };
  if (input.linkedInUrl) body.linkedInUrl = input.linkedInUrl;
  const json = await call<{ results: AshbyCandidate }>(
    apiKey,
    "candidate.update",
    body,
  );
  return json.results;
}

/**
 * Attach a candidate to a job as an application. With no interviewStageId, Ashby
 * lands the application in the job's first "Lead"-type stage.
 */
export async function createApplication(
  apiKey: string,
  input: { candidateId: string; jobId: string; interviewStageId?: string; sourceId?: string },
): Promise<AshbyApplication> {
  const body: Record<string, unknown> = {
    candidateId: input.candidateId,
    jobId: input.jobId,
  };
  if (input.interviewStageId) body.interviewStageId = input.interviewStageId;
  if (input.sourceId) body.sourceId = input.sourceId;
  const json = await call<{ results: AshbyApplication }>(
    apiKey,
    "application.create",
    body,
  );
  return json.results;
}

/**
 * Attach an existing (externally-sent) email to a candidate so it renders as email
 * activity in the candidate feed. `emailProviderEmailId` is the idempotency key
 * (unique per API key) — re-sending the same id will not duplicate.
 */
export async function addEmailMessage(
  apiKey: string,
  input: {
    candidateId: string;
    emailProviderEmailId: string;
    subject: string;
    from: string;
    to: string;
    body: string;
    sentAt?: string;
    cc?: string;
    threadId?: string;
    messageIdHeader?: string;
  },
): Promise<void> {
  const body: Record<string, unknown> = {
    candidateId: input.candidateId,
    emailProviderEmailId: input.emailProviderEmailId,
    subject: input.subject,
    from: input.from,
    to: input.to,
    body: input.body,
  };
  if (input.sentAt) body.sentAt = input.sentAt;
  if (input.cc) body.cc = input.cc;
  if (input.threadId) body.threadId = input.threadId;
  if (input.messageIdHeader) body.messageIdHeader = input.messageIdHeader;
  await call(apiKey, "candidate.addEmailMessage", body);
}

/**
 * The candidate's existing application on this job, if any.
 *
 * Guards the reconciler's backfill: a contact can be missing from D1 while their
 * Ashby application exists, and creating a second one for the same job would put
 * a duplicate in the pipeline. Returns null when they have none.
 */
export async function findApplicationForJob(
  apiKey: string,
  candidateId: string,
  jobId: string,
): Promise<AshbyApplication | null> {
  const info = await call<{ results: AshbyCandidate & { applicationIds?: string[] } }>(
    apiKey,
    "candidate.info",
    { id: candidateId },
  );
  for (const applicationId of info.results?.applicationIds ?? []) {
    const app = await call<{ results: AshbyApplication & { job?: { id?: string } } }>(
      apiKey,
      "application.info",
      { applicationId },
    );
    if (app.results?.job?.id === jobId) return app.results;
  }
  return null;
}

/** Read one application (used to check where it sits before moving it). */
export async function getApplication(
  apiKey: string,
  applicationId: string,
): Promise<AshbyApplication> {
  const json = await call<{ results: AshbyApplication }>(
    apiKey,
    "application.info",
    { applicationId },
  );
  return json.results;
}

/** Move an application to a different interview stage. */
export async function changeStage(
  apiKey: string,
  input: { applicationId: string; interviewStageId: string },
): Promise<AshbyApplication> {
  const json = await call<{ results: AshbyApplication }>(
    apiKey,
    "application.changeStage",
    {
      applicationId: input.applicationId,
      interviewStageId: input.interviewStageId,
    },
  );
  return json.results;
}
