/** Bindings and vars available to the Worker (see wrangler.toml). */
export interface Env {
  DB: D1Database;

  // vars
  DEFAULT_JOB_ID: string;
  ASHBY_SOURCE_ID: string;

  // secrets
  ASHBY_API_KEY: string;
  WEBHOOK_TOKEN: string;
  APOLLO_MASTER_KEY?: string;
}
