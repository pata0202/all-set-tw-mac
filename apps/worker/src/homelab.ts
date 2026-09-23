import { failEinvoiceSyncRun } from "./features/sync/einvoice-sync-service";
import { failTdccSyncRun } from "./features/sync/tdcc-sync-service";
import worker from "./index";
import type { Env, ScheduledSyncQueueMessage } from "./platform/env";

type HomelabEnv = Env & { OCR_URL?: string; OCR_TOKEN?: string };

// Common Vision misreads when the CAPTCHA is digits only.
const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0", o: "0", D: "0", Q: "0",
  I: "1", l: "1", i: "1", "|": "1",
  Z: "2", z: "2",
  S: "5", s: "5",
  G: "6", b: "6",
  T: "7",
  B: "8",
  g: "9", q: "9",
};

/** Pick the first OCR candidate that cleans up to the expected shape. */
export function pickCaptcha(candidates: string[], digits: boolean, count: number) {
  const cleaned = candidates.map((text) =>
    digits
      ? [...text].map((c) => DIGIT_LOOKALIKES[c] ?? c).join("").replace(/\D/g, "")
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
      const content = pickCaptcha((await response.text()).split("\n"), digits, count);
      return { choices: [{ message: { content } }] };
    },
  } as unknown as Ai;
}

const withLocalAi = (env: HomelabEnv): HomelabEnv => ({ ...env, AI: localAi(env) });

// Auth is the reverse proxy's job. Present every request as localhost so
// accessMiddleware's LOCAL_DEV_MODE bypass applies; the proxy keeps its own Host
// header, which keeps wrangler's /cdn-cgi/local/explorer (raw DB access) at 403.
function asLocal(request: Request) {
  const url = new URL(request.url);
  url.hostname = "localhost";
  return new Request(url, request);
}

const ACTIVE_RUN = `status IN ('queued','initializing','processing','promoting')`;
const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// /homelab/sync: list sync locks and active runs, with a button to clear each.
// Clearing only resets DB state; an in-flight browser job still runs until it
// ends on its own (restart the service to kill it outright).
async function syncPage(request: Request, env: HomelabEnv) {
  const db = env.DB;
  if (request.method === "POST") {
    // Same-origin only, so another site can't trigger this through the proxy's login cookie.
    if (request.headers.get("sec-fetch-site") !== "same-origin")
      return new Response("Forbidden", { status: 403 });
    const form = await request.formData();
    const kind = form.get("kind");
    const id = String(form.get("id"));
    const reason = new Error("手動停止（/homelab/sync）");
    if (kind === "lock")
      await db
        .prepare(`UPDATE sync_jobs SET locked_until=NULL, locked_by=NULL, lock_trigger=NULL, lock_scope=NULL WHERE id=?`)
        .bind(id)
        .run();
    if (kind === "einvoice") await failEinvoiceSyncRun(env, id, reason, true);
    if (kind === "tdcc") await failTdccSyncRun(env, id, reason, true);
    return Response.redirect(new URL(request.url).href, 303);
  }

  type Row = { id: string; name: string; detail: string; until: string };
  const [locks, einvoice, tdcc] = await Promise.all([
    db.prepare(`SELECT id, connector_id AS name, lock_trigger AS detail, locked_until AS until FROM sync_jobs WHERE locked_until IS NOT NULL`).all<Row>(),
    db.prepare(`SELECT id, 'einvoice' AS name, status AS detail, updated_at AS until FROM einvoice_sync_runs WHERE ${ACTIVE_RUN}`).all<Row>(),
    db.prepare(`SELECT id, 'tdcc' AS name, status AS detail, updated_at AS until FROM tdcc_sync_runs WHERE ${ACTIVE_RUN}`).all<Row>(),
  ]);
  const rows = [
    ...locks.results.map((row) => ({ ...row, kind: "lock", label: "鎖定到" })),
    ...einvoice.results.map((row) => ({ ...row, kind: "einvoice", label: "更新於" })),
    ...tdcc.results.map((row) => ({ ...row, kind: "tdcc", label: "更新於" })),
  ];
  const body = rows.length
    ? rows
        .map(
          (row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.detail)}</td>
<td>${escapeHtml(row.label)} ${escapeHtml(row.until)}</td>
<td><form method="post"><input type="hidden" name="kind" value="${escapeHtml(row.kind)}">
<input type="hidden" name="id" value="${escapeHtml(row.id)}"><button>停止</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4">沒有正在同步的項目</td></tr>`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>同步狀態</title><style>body{font:15px system-ui;margin:16px}td,th{padding:6px 10px;text-align:left;border-bottom:1px solid #ccc}</style>
<h1>正在同步</h1><p><a href="">重新整理</a>・<a href="/">回首頁</a></p>
<table><tr><th>來源</th><th>狀態</th><th>時間</th><th></th></tr>${body}</table>
<p>「停止」只會清掉資料庫裡的鎖和狀態；已經在跑的瀏覽器要等它自己結束，或重啟服務。</p>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export default {
  fetch: (request, env, ctx) =>
    new URL(request.url).pathname === "/homelab/sync"
      ? syncPage(request, env)
      : worker.fetch(asLocal(request), withLocalAi(env), ctx),
  queue: (batch, env) => worker.queue(batch, withLocalAi(env)),
} satisfies ExportedHandler<HomelabEnv, ScheduledSyncQueueMessage>;
