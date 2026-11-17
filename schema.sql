-- One row per Apollo contact we've processed. Powers idempotency (never double-create /
-- double-move) and lets the reply webhook find the Ashby application to advance.
CREATE TABLE IF NOT EXISTS contacts (
  apollo_contact_id    TEXT PRIMARY KEY,
  email                TEXT,
  ashby_candidate_id   TEXT,
  ashby_application_id  TEXT,
  sequence_id          TEXT,
  added_at             TEXT,   -- ISO 8601; set when the Ashby lead is created
  replied_at           TEXT,   -- ISO 8601; set when moved to the replied stage
  linkedin_url         TEXT    -- set once written onto the Ashby candidate; null = still needs one
);

-- Existing deployments: add the column without touching the rows already there.
-- ALTER TABLE contacts ADD COLUMN linkedin_url TEXT;

-- Look up a contact by email when the reply payload has no Apollo contact id.
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (email);

-- Sequence -> Ashby routing. Edit this table to add/change routing WITHOUT redeploying.
--   lead_stage_id blank  -> application lands in the job's default first "Lead" stage.
--   replied_stage_id     -> the stage the application moves to when the contact replies.
CREATE TABLE IF NOT EXISTS sequence_job_map (
  sequence_id      TEXT PRIMARY KEY,
  sequence_name    TEXT,
  ashby_job_id     TEXT NOT NULL,
  lead_stage_id    TEXT,
  replied_stage_id TEXT NOT NULL
);
