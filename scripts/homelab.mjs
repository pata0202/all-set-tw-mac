// Homelab launcher: Apple Vision OCR relay + scripts/dev-worker.mjs (CTBC relay + wrangler dev).
// Usage: node scripts/homelab.mjs   (env: PORT, default 8787)
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = path.join(root, "apps", "worker");
const config = "apps/worker/wrangler.homelab.toml";
const ocrBinary = path.join(root, "homelab", "ocr");
const devVars = path.join(worker, ".dev.vars");
const port = process.env.PORT ?? "8787";
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, ".wrangler-config") },
  });

if (!existsSync(devVars)) {
  // Losing this key makes every saved connector credential unreadable — back it up.
  writeFileSync(
    devVars,
    `CONFIG_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nLOCAL_DEV_MODE=true\n`,
    { mode: 0o600 },
  );
  console.log(`Created ${devVars} — back up CONFIG_ENCRYPTION_KEY now.`);
}
if (!existsSync(ocrBinary))
  run("swiftc", ["-O", "homelab/ocr.swift", "-o", ocrBinary]);
if (!existsSync(path.join(root, "apps", "web", "dist")))
  run("npm", ["run", "build", "-w", "@taiwan-fin-hub/web"]);
run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "-c", config]);

const ocrToken = randomBytes(32).toString("hex");
const ocr = createServer((request, response) => {
  if (request.method !== "POST" || request.headers["x-ocr-token"] !== ocrToken) {
    response.writeHead(404).end();
    return;
  }
  const child = spawn(ocrBinary, [], { timeout: 15_000 });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.on("error", () => response.writeHead(502).end());
  child.on("close", (code) =>
    response.headersSent || response.writeHead(code === 0 ? 200 : 502).end(out),
  );
  request.pipe(child.stdin);
});
await new Promise((resolve) => ocr.listen(0, "127.0.0.1", resolve));
const ocrUrl = `http://127.0.0.1:${ocr.address().port}/ocr`;
console.log(`Vision OCR relay ready on ${ocrUrl}`);

const dev = spawn(
  "node",
  [
    "scripts/dev-worker.mjs",
    "--",
    "dev", "-c", config,
    "--ip", "127.0.0.1", "--port", port,
    "--show-interactive-dev-session=false",
    "--var", `OCR_URL:${ocrUrl}`,
    "--var", `OCR_TOKEN:${ocrToken}`,
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, X_BROWSER_HEADFUL: process.env.X_BROWSER_HEADFUL ?? "false" },
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => dev.kill(signal));
dev.once("exit", (code) => {
  ocr.close();
  process.exit(code ?? 1);
});
