# Homelab（macOS）自架

在 Apple Silicon Mac 上以 `wrangler dev` 本機模式執行，不需要 Cloudflare 帳號。

| 原本 | Homelab |
| --- | --- |
| D1 | 本機 SQLite：`apps/worker/.wrangler/state/` |
| Browser Run | 本機 Chromium（Miniflare 自動下載） |
| Workers AI（Gemma 4 OCR） | Apple Vision：`homelab/ocr.swift` |
| Cloudflare Access | 由前面的 reverse proxy 負責 |
| Cron／排程同步 | 不啟用，請在介面手動同步 |

上游檔案皆未修改；homelab 專屬檔案：`apps/worker/wrangler.homelab.toml`、`apps/worker/src/homelab.ts`、`scripts/homelab.mjs`、`homelab/`。

## 需求

- Apple Silicon Mac、Node.js 24、Xcode Command Line Tools（`xcode-select --install`）

## 啟動

```bash
npm install
node scripts/homelab.mjs
```

首次啟動會自動：產生 `apps/worker/.dev.vars`（含 `CONFIG_ENCRYPTION_KEY`）、編譯 `homelab/ocr`、build 前端、套用 DB migration。服務只監聽 `127.0.0.1:8787`。

**請立刻備份 `apps/worker/.dev.vars` 的 `CONFIG_ENCRYPTION_KEY`**，遺失後所有連接器帳密都無法解密。

## 常駐（launchd）

```bash
sed "s#REPO_DIR#$PWD#g" homelab/tw.allset.homelab.plist > ~/Library/LaunchAgents/tw.allset.homelab.plist
launchctl load ~/Library/LaunchAgents/tw.allset.homelab.plist
```

若 `node` 不在 `/opt/homebrew/bin`（例如 nvm），請修改 plist 內的 `PATH`。Log 位於 `homelab/homelab.log`。

## Reverse proxy

- 登入保護一定要做（Authelia、Authentik、Cloudflare Tunnel + Access 等）；本服務自身**不驗證身分**。
- 轉發時**保留原本的 Host**，不要改成 `localhost`，否則 wrangler 的 `/cdn-cgi/local/explorer`（可直接讀取資料庫）會對外開放。保險起見也可以在 proxy 直接封鎖 `/cdn-cgi/`。

## 備份

停止服務後備份 `apps/worker/.wrangler/state/` 與 `apps/worker/.dev.vars`。

## 更新上游

```bash
git pull https://github.com/TedLin1993/all-set-tw main
rm -rf apps/web/dist && node scripts/homelab.mjs
```

## 已知限制

- Vision 是一般 OCR，對扭曲驗證碼的辨識率不如原本的 Gemma 4；失敗時介面會顯示 `OCR_FAILED`，重試即可。
- `homelab.ts` 依上游 OCR prompt 文字判斷數字／英數與長度，上游改 prompt 時需同步調整。
