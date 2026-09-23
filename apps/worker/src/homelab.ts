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

export default {
  fetch: (request, env, ctx) =>
    worker.fetch(asLocal(request), withLocalAi(env), ctx),
  queue: (batch, env, ctx) => worker.queue(batch, withLocalAi(env), ctx),
} satisfies ExportedHandler<HomelabEnv, ScheduledSyncQueueMessage>;
