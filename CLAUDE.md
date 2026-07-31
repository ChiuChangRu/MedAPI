# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This repo (despite the name `MedAPI`) currently contains a single active project: **fieldlog/**, a personal field-notes PWA ("隨身記"). The repo root also has a static `index` file (an HTML reference table of medical-device APIs) which is standalone content, not part of any app.

All active development happens under `fieldlog/`. There is no root build system, package.json, or monorepo tooling — `fieldlog/` is deployed independently as its own Cloudflare Worker.

## fieldlog/ — architecture

A Cloudflare Worker (`fieldlog/src/worker.js`) serving both a static PWA frontend (`fieldlog/public/`) and a JSON API under `/api/*`, backed by D1 (SQLite), R2 (file storage), and Workers AI (audio transcription + image OCR).

**Request routing** (`worker.js` default export): any path under `/api/*` requires the `x-pin` header (or `?pin=`) to match the `FIELD_PIN` secret. If `FIELD_PIN` is unset, all API access is rejected (fail-closed by design — do not change this to a permissive default). Non-API paths fall through to `env.ASSETS.fetch(request)` (the static PWA).

**Data model** (D1, schema auto-created in `ensureSchema`):
- `folders` — one activity/project (參展/拜訪/實驗/上課/其他), each `type` maps to a field template defined client-side in `app.js` (`FOLDER_TEMPLATES`)
- `entries` — one record; `folder_id IS NULL` means it's still in the inbox, unfiled
- `attachments` — photos/audio segments/files stored in R2; `offset_secs` records how many seconds into a recording a photo was taken, used later to correlate photos with transcript segments
- `history` — append-only audit log
- Raw data is insert/update only for content, but user-facing delete endpoints exist for entries/attachments (used for corrections) — the "no deletion" principle in the README refers to not silently mutating/losing captured raw data during normal use, not an enforced DB constraint

Schema changes: add new `CREATE TABLE`/`CREATE INDEX` statements to `SCHEMA`, or additive `ALTER TABLE` statements to `MIGRATIONS` (D1 has no `ADD COLUMN IF NOT EXISTS`, so migration failures are swallowed intentionally — keep migrations additive-only).

**AI integration** (`fieldlog/src/imageSkill.js`): this is described in the file header as "the one canonical copy" — a sibling `cloudflare/`-based project (Medtec visit system, not in this repo) has its own synced copy. If you change OCR prompts, models, or guardrails, this file is the source of truth. Two models are used deliberately kept separate: `OCR_MODEL` (vision, reads text only from the image, must never see the transcript) and `RELATION_MODEL` (text-only, correlates OCR output with a transcript segment afterward). Do not merge these into a single call — the header documents that feeding the transcript into the vision prompt causes the model to hallucinate transcript content as if it were in the image. `detectRepetitionLoop` guards against degenerate repeated-token output; failed OCR is never written to the DB.

**Frontend** (`fieldlog/public/`): vanilla JS, no framework/bundler (`app.js` is a single file, loaded directly via `<script src="app.js">`). PIN is stored in `localStorage` and sent on every API call via `api()`. Offline support: failed file uploads are queued in IndexedDB (`fieldlog_pending` store) via `queueFile`/`syncPendingFiles`, and re-sent on reconnect (`window.addEventListener("online", syncPendingFiles)`); the service worker (`sw.js`) only caches the static shell (network-first) and explicitly bypasses `/api/*`.

**Export flow**: `GET /api/export/folder/:id` renders an entire folder's entries/attachments as a single Markdown document for manual hand-off to an LLM (the workflow is: export → paste into Claude/GPT → get a report → paste into Notion). This endpoint is the one place presentation logic (Markdown formatting, timestamp formatting via `fmtSecs`) lives server-side, mirroring `fmtSecs` in `app.js`.

## Development

There is no local package.json/build step — this is deployed directly via Wrangler against `fieldlog/wrangler.jsonc`. Common commands, run from `fieldlog/`:

```bash
npx wrangler deploy          # deploy to Cloudflare
npx wrangler dev             # local dev server (requires binding config for D1/R2/AI)
npx wrangler tail            # tail production logs
```

Bindings (`fieldlog/wrangler.jsonc`): `DB` (D1, database name `fieldlog`), `FILES` (R2 bucket `fieldlog-files`), `AI` (Workers AI, no separate provisioning needed), `ASSETS` (serves `public/`). The `FIELD_PIN` secret must be set in the Worker's dashboard (Settings → Variables and Secrets) — it is never in source, and its absence hard-fails all API requests rather than falling open.

No automated test suite exists in this repo — changes are validated by deploying and exercising the PWA manually (see `fieldlog/README.md` for the deploy walkthrough and the end-to-end usage flow: capture → transcribe/OCR → file into folder → export → hand off to an LLM → paste into Notion).

Everything in this project is Traditional Chinese (UI strings, commit messages, comments) — match that when editing user-facing text or writing commits for this repo.

## 新增功能：原始附件存取 API（2026-07-31）

**背景**：為支持 MyWiki MCP 取得原始圖片和 PDF 檔案（而非只有提取後的文字），新增統一的附件存取端點。

**API 端點**：`GET /api/attachments/:id/raw?mode=url|inline`

**行為**：
- 圖片 ≤2MB：預設 `mode=inline`，直接回傳 base64，無需簽名網址
- 大檔案/PDF：`mode=url`，回傳 R2 簽名網址（有效期 10 分鐘）

**回傳格式**（mode=inline）：
```json
{
  "id": 266,
  "filename": "photo.jpg",
  "mime_type": "image/jpeg",
  "encoding": "base64",
  "data": "<base64 string>"
}
```

**回傳格式**（mode=url）：
```json
{
  "id": 266,
  "filename": "large.pdf",
  "mime_type": "application/pdf",
  "url": "https://...(signed)",
  "expires_at": "2026-07-31T12:10:00Z",
  "size_bytes": 842213
}
```

**MCP 前端**：待在 Mywiki MCP server 端添加工具定義 `get_fieldlog_attachment_raw(id, mode?)`

**安全性**：簽名網址限定單一附件、10 分鐘失效、沿用既有 FIELD_PIN 驗證機制（fail-closed）

### 批次自動轉文字（2026-07-31）

**端點**：`POST /api/batch/process-attachments`

**用途**：自動為資料夾或單筆紀錄內未處理的附件觸發 OCR（照片）和語音轉文字（錄音），無需逐一手動點擊。

**請求**：
```json
{
  "folder_id": 123  // 或 "entry_id": 456（二選一）
}
```

**回傳**：
```json
{
  "processed": 5,
  "results": [
    {"attachment_id": 1, "kind": "audio", "filename": "rec.m4a", "success": true, "message": "轉文字成功，2847 字"},
    {"attachment_id": 2, "kind": "photo", "filename": "pic.jpg", "success": true, "message": "擷取文字成功，156 字"}
  ]
}
```

**特性**：
- 批次掃描所有「尚未處理」的附件（transcript 或 ocr_text 為空）
- 照片：同時執行 OCR + 對話關聯判斷（若存在同時段錄音逐字稿）
- 錄音：使用 Workers AI Whisper 轉文字
- 失敗時回傳錯誤訊息但繼續處理其他附件

### PDF 分頁提取（2026-07-31，框架預留）

**參數**：`GET /api/attachments/:id/raw?page=2`

**現況**：
- Worker 端接受並驗證 `page` 參數（僅限 PDF）
- 實際 PDF 分頁轉圖片需在 MCP server 端用 `pdf.js` 或 `pdftoppm` 處理
- Cloudflare Workers 執行環境無法直接跑重型 PDF 處理，故決策延後到 MCP 層實作
- 回傳會包含 `page_requested` 和 `page_note` 字段提醒用戶
