// Apollo -> Ashby lead sync. Push-based Cloudflare Worker.
//
// Apollo Workflows POST here in real time:
//   POST /apollo/added?token=…    contact added to a sequence  -> create Ashby lead
//   POST /apollo/replied?token=…  contact replied              -> move to replied stage
// Every request must carry the shared ?token= secret (WEBHOOK_TOKEN).

import type { Env } from "./env.js";
import { handleAdded, handleReplied, type SyncResult } from "./sync.js";
import { reconcileFromMessages, reconcileReplies, deepReplyScan } from "./reconcile.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "apollo-ashby-sync" });
    }

    // Manual run of the same reconciliation the cron does, for testing or catch-up.
    // ?deep=1 runs only the out-of-sequence reply sweep; ?full=1 walks every mapped
    // sequence via contacts/search (heavy, spends the add webhook's budget).
    if (url.pathname === "/admin/reconcile") {
      if (!tokenOk(url, env)) return text("forbidden", 403);
      try {
        if (url.searchParams.get("deep") === "1") return json(await deepReplyScan(env));
        if (url.searchParams.get("full") === "1") return json(await reconcileReplies(env));
        return json(await reconcileFromMessages(env));
      } catch (err) {
        return json({ status: "error", detail: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // All webhook routes require the shared token.
    if (url.pathname.startsWith("/apollo/")) {
      if (request.method !== "POST") return text("method not allowed", 405);
      if (!tokenOk(url, env)) return text("forbidden", 403);

      const payload = await safeJson(request);
      if (payload === undefined) return text("invalid JSON body", 400);

      // Routing key comes from the URL (?route=…), since Apollo can't resolve a
      // sequence_id merge tag. Each Apollo workflow points at its own route.
      const routeKey = url.searchParams.get("route") ?? undefined;

      try {
        let result: SyncResult;
        if (url.pathname === "/apollo/added") {
          result = await handleAdded(env, payload, routeKey);
        } else if (url.pathname === "/apollo/replied") {
          result = await handleReplied(env, payload, routeKey);
        } else {
          return text("not found", 404);
        }
        console.log(`[${url.pathname}] ${result.status}: ${result.detail}`);
        // Always 200 on handled events (even skips/noops) so Apollo doesn't retry-storm.
        return json({ status: result.status, detail: result.detail });
      } catch (err) {
        // Return 500 so Apollo may retry a genuine failure (Ashby down, etc.).
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${url.pathname}] error: ${msg}`);
        return json({ status: "error", detail: msg }, 500);
      }
    }

    return text("not found", 404);
  },

  // Safety net for the webhooks, hourly: one download of Apollo's recent sent
  // messages backfills missed adds and recovers missed replies.
  //
  // Awaited, NOT ctx.waitUntil: a scheduled run gets 15 minutes of wall time, but
  // waitUntil work only gets 30 seconds past the handler returning. Under
  // waitUntil the run died as exceededWallTime with no logs.
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    try {
      await reconcileFromMessages(env);
    } catch (err) {
      console.error(`[reconcile] run failed: ${err instanceof Error ? err.message : err}`);
    }
  },
} satisfies ExportedHandler<Env>;

function tokenOk(url: URL, env: Env): boolean {
  const t = url.searchParams.get("token");
  return !!t && !!env.WEBHOOK_TOKEN && t === env.WEBHOOK_TOKEN;
}

async function safeJson(request: Request): Promise<any | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
