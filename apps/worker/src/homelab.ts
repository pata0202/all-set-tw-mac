import { failEinvoiceSyncRun } from "./features/sync/einvoice-sync-service";
import { failTdccSyncRun } from "./features/sync/tdcc-sync-service";
import worker from "./index";
import type { Env, ScheduledSyncQueueMessage } from "./platform/env";

type HomelabEnv = Env & { OCR_URL?: string; OCR_TOKEN?: string };

// Common Vision misreads when the CAPTCHA is digits only.
const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0",
  o: "0",
  D: "0",
  Q: "0",
  I: "1",
  l: "1",
  i: "1",
  "|": "1",
  Z: "2",
  z: "2",
  S: "5",
  s: "5",
  G: "6",
  b: "6",
  T: "7",
  B: "8",
  g: "9",
  q: "9",
};

/** Pick the first OCR candidate that cleans up to the expected shape. */
export function pickCaptcha(
  candidates: string[],
  digits: boolean,
  count: number,
) {
  const cleaned = candidates.map((text) =>
    digits
      ? [...text]
          .map((c) => DIGIT_LOOKALIKES[c] ?? c)
          .join("")
          .replace(/\D/g, "")
      : text.replace(/[^A-Za-z0-9]/g, ""),
  );
  return cleaned.find((text) => text.length === count) ?? cleaned[0] ?? "";
}

// Stand-in for the Workers AI binding. features/ocr/service.ts only calls
// ai.run() with [text prompt, data: URL image] and reads choices[0].message.content;
// its own regex still validates whatever we return.
// ponytail: parses the upstream prompt text for digits/count; revisit if upstream rewords it.
function localAi(env: HomelabEnv) {
  return {
    async run(_model: string, input: any) {
      const [prompt, image] = input.messages[0].content;
      const digits = /digits in this CAPTCHA/.test(prompt.text);
      const count = Number(/Read the (\d+)/.exec(prompt.text)?.[1]);
      const base64 = String(image.image_url.url).split(",")[1] ?? "";
      const response = await fetch(env.OCR_URL!, {
        method: "POST",
        headers: { "x-ocr-token": env.OCR_TOKEN ?? "" },
        body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      });
      if (!response.ok) throw new Error(`Local OCR failed: ${response.status}`);
      const content = pickCaptcha(
        (await response.text()).split("\n"),
        digits,
        count,
      );
      return { choices: [{ message: { content } }] };
    },
  } as unknown as Ai;
}

const withLocalAi = (env: HomelabEnv): HomelabEnv => ({
  ...env,
  AI: localAi(env),
});

// Auth is the reverse proxy's job. Present every request as localhost so
// accessMiddleware's LOCAL_DEV_MODE bypass applies; the proxy keeps its own Host
// header, which keeps wrangler's /cdn-cgi/local/explorer (raw DB access) at 403.
function asLocal(request: Request) {
  const url = new URL(request.url);
  url.hostname = "localhost";
  return new Request(url, request);
}

const ACTIVE_RUN = `status IN ('queued','initializing','processing','promoting')`;
const json = (data: unknown, status = 200) => Response.json(data, { status });

export type HomelabSyncRun = {
  kind: "lock" | "einvoice" | "tdcc";
  id: string;
  connectorId: string;
  status: string;
  at: string;
};

// GET  /api/homelab/sync-runs       → bank locks + active e-invoice/TDCC runs
// POST /api/homelab/sync-runs/stop  → { kind, id }
// Stopping only resets DB state; an in-flight browser job still runs until it
// ends on its own (restart the service to kill it outright).
async function syncRunsApi(request: Request, env: HomelabEnv, path: string) {
  const db = env.DB;
  if (path === "/api/homelab/sync-runs" && request.method === "GET") {
    const [locks, einvoice, tdcc] = await Promise.all([
      db
        .prepare(
          `SELECT id, connector_id AS connectorId, COALESCE(lock_trigger, '') AS status, locked_until AS at FROM sync_jobs WHERE locked_until IS NOT NULL`,
        )
        .all<HomelabSyncRun>(),
      db
        .prepare(
          `SELECT id, 'einvoice' AS connectorId, status, updated_at AS at FROM einvoice_sync_runs WHERE ${ACTIVE_RUN}`,
        )
        .all<HomelabSyncRun>(),
      db
        .prepare(
          `SELECT id, 'tdcc' AS connectorId, status, updated_at AS at FROM tdcc_sync_runs WHERE ${ACTIVE_RUN}`,
        )
        .all<HomelabSyncRun>(),
    ]);
    return json([
      ...locks.results.map((row) => ({ ...row, kind: "lock" })),
      ...einvoice.results.map((row) => ({ ...row, kind: "einvoice" })),
      ...tdcc.results.map((row) => ({ ...row, kind: "tdcc" })),
    ]);
  }
  if (path === "/api/homelab/sync-runs/stop" && request.method === "POST") {
    // Same-origin only, so another site can't trigger this through the proxy's login cookie.
    if (request.headers.get("sec-fetch-site") !== "same-origin")
      return json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, 403);
    const { kind, id } = (await request.json()) as Pick<
      HomelabSyncRun,
      "kind" | "id"
    >;
    const reason = new Error("手動停止");
    if (kind === "lock")
      await db
        .prepare(
          `UPDATE sync_jobs SET locked_until=NULL, locked_by=NULL, lock_trigger=NULL, lock_scope=NULL WHERE id=?`,
        )
        .bind(id)
        .run();
    else if (kind === "einvoice")
      await failEinvoiceSyncRun(env, id, reason, true);
    else if (kind === "tdcc") await failTdccSyncRun(env, id, reason, true);
    else
      return json(
        { error: { code: "INVALID_KIND", message: "Unknown kind." } },
        400,
      );
    return json({ success: true });
  }
  return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
}

export default {
  fetch: (request, env, ctx) => {
    const path = new URL(request.url).pathname;
    return path.startsWith("/api/homelab/")
      ? syncRunsApi(request, env, path)
      : worker.fetch(asLocal(request), withLocalAi(env), ctx);
  },
  queue: (batch, env) => worker.queue(batch, withLocalAi(env)),
} satisfies ExportedHandler<HomelabEnv, ScheduledSyncQueueMessage>;
