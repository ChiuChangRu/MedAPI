# GPT 接手期間變更交接（給 Claude）

> 目的：說明 MyWiki 自基準 `fa9485c`（v108）由 GPT 接手後，到目前正式分支
> `codex/kiwi-integration` 的變更、決策、部署狀態與未完成事項。
>
> 本文件不含任何 PIN、Token 或 Secret 實際值。不要把機密補進 git。

## 1. 目前正式狀態

| 項目 | 狀態 |
|---|---|
| GitHub | `ChiuChangRu/MedAPI` |
| 正式分支 | `codex/kiwi-integration` |
| GPT 接手基準 | `fa9485c`，MyWiki v108 |
| 本文件撰寫時正式提交 | `0e92cd0` |
| MyWiki / fieldlog 正式網址 | `https://fieldlog.gogoyankee.workers.dev/` |
| MyWiki UI 版本 | v110 |
| MCP 正式網址 | `https://medapi-mcp.gogoyankee.workers.dev/mcp` |
| Claude 舊 PIN/Bearer 接法 | 保留相容，不應被 OAuth 改動破壞 |
| ChatGPT 自訂 MCP | 伺服器端已建置，但 ChatGPT 端未成功載入工具，視為未完成 |

`HANDOVER.md` 與 `mcp/README.md` 的部分說明早於本輪變更，例如「MCP 不支援
OAuth」及 MCP 部署方式，已可能過時。衝突時以本文件、git commit 與實際程式碼
為準，並應回頭更新舊文件。

## 2. 使用者已確認、不得自行改回的規則

1. 電腦外部檔案拖入任何頁面，一律建立到「待分類」。
2. 「待分類」是系統快捷入口，不屬於第一至第四階資料夾。
3. MyWiki 內部內容可拖到資料夾進行移動。
4. 外部檔案拖進既有紀錄時，仍附加到該紀錄，不另外建立待分類紀錄。
5. 錄音紀錄維持完整資料包結構，錄音、照片、附件不拆散。
6. 公開介面用詞統一為「待分類／分類／移動」。
7. Windows 式階層語意：把 A 拖進 B，結果是 `B/A`，A 是完整資料包，不能把
   A 的內容打散或合併進 B。
8. `B → A → C` 表示 B 裡有 A、A 裡有 C；搬動 B 時 A/C 一起搬，刪除 B 時
   A/C 一起進垃圾桶。
9. 刪除不是「內容安全上移」。父項刪除時整棵子樹一起刪除，行為比照 Windows。
10. 垃圾桶保留固定 60 天，也可由使用者手動永久刪除。

## 3. 桌機檔案總管與 v109/v110

### 3.1 桌機／手機介面

- 桌機新增左側資料夾樹，右側維持圖示／清單／詳細三種檢視模式。
- 左側有「待分類」快捷入口、資料夾樹、新增資料夾與垃圾桶。
- 手機不套用雙欄檔案總管，固定維持原本清單操作。
- 相關檔案：
  - `fieldlog/public/index.html`
  - `fieldlog/public/style.css`
  - `fieldlog/public/app.js`

### 3.2 資料夾內容統一

使用者曾指出同一個資料夾被拆成三種視覺區塊（檔案、錄音與多檔案紀錄、筆記）
不符合檔案總管直覺。v110 已改為：

- 子資料夾與內容出現在同一個可排序區域。
- 子資料夾優先，其後依目前排序規則顯示 PDF、一般記事、錄音資料包等。
- 移除資料夾頁原本三個互相分離的內容區塊。
- 視覺統一不代表資料模型被打散；錄音與多附件紀錄仍是資料包。
- `fieldlog/public/app.js` 的 `APP_VERSION`、Worker `UI_VERSION`、HTML query 與
  service worker cache 目前同步為 v110。

## 4. 記錄資料包階層

- `entries` 新增 `parent_entry_id`，讓記事／錄音紀錄本身能像資料夾一樣巢狀。
- 記錄階層與正式資料夾四層限制是兩套概念；記事巢狀不計入資料夾深度。
- 當子資料包放入另一筆記事時，保留完整記事、內文、附件與其子資料包。
- 伺服器必須拒絕：
  - 自己放到自己底下。
  - 把祖先放到其後代底下造成循環。
  - 目標不存在、已刪除或在垃圾桶。
- 巢狀記事沿用最外層資料包的 `folder_id`；搬動整筆資料包時，子樹的
  `folder_id` 要一致更新。資料夾一般清單應只列 `parent_entry_id IS NULL` 的
  根資料包，避免子項重複顯示。
- 舊的 merge API 是破壞性合併，不等於 Windows 式移動。不要用 merge 來實作
  `A → B` 的資料包巢狀。

## 5. 垃圾桶與 60 天清除

### 5.1 邏輯刪除

- `folders`、`entries` 新增 `deleted_at`。
- 新增 `trash_items` 狀態欄位：`state`、`attempts`、`last_error`、
  `purge_started_at` 等。
- 刪除資料夾時，資料夾子樹、其中記事資料包與附件關係全部保留，只標記刪除。
- 刪除記事時，該記事與所有 `parent_entry_id` 後代一起進垃圾桶。
- 正常清單、搜尋、匯出與 MCP 查詢必須排除垃圾桶內容。
- 重複刪除使用 `ON CONFLICT ... DO NOTHING`，避免重複請求直接 500。

### 5.2 還原

- 只能還原 `state='trashed'` 的項目。
- 原父資料夾／外層記事仍存在時，還原到原位置。
- 原位置已不存在時，不得偷偷還原到根目錄；回傳衝突並要求使用者選新位置。
- 還原時仍需防止資料夾循環與記事循環。

### 5.3 永久刪除與排程

- 固定 60 天，以 `purge_after` 判斷到期。
- 手動永久刪除與排程清除走同一套 purge engine。
- 先把 `trash_items.state` claim 成 `purging`，避免還原與清除競態。
- 永久刪除順序：先刪 R2 檔案；全部成功後才刪 D1 的附件、關聯、history、
  reservation、entries、folders 與 tombstone。
- R2 失敗時保留 D1 metadata，記錄 `attempts/last_error`，恢復成 `trashed` 後重試。
- 有附件但缺少 `FILES` binding 時 fail closed，不允許只刪 D1 留下孤兒 R2。
- 大量 ID 操作以小批次執行，避免 D1/SQLite bind parameter 上限。
- 實作集中在 `fieldlog/src/lib/trash.js`。

## 6. 拖放優先順序

拖放事件的判斷順序不能只看 `Files`，因為瀏覽器可能同時帶內部 MIME 與 Files：

1. 先判斷 MyWiki 自訂的內部拖放 MIME。
2. 內部記事拖到資料夾：移動完整資料包。
3. 內部記事拖到記事：建立 Windows 式巢狀，不做 merge。
4. 外部檔案拖到既有記事：附加到該記事。
5. 外部檔案拖到其他任何頁面、資料夾樹或空白處：建立到「待分類」。
6. 命中記事 drop target 後要停止事件傳播，不能同時再觸發頁面層待分類上傳。

資料夾工具列中使用者明確按「上傳檔案」仍可上傳到目前資料夾；這和外部拖放
一律進待分類是不同操作，不要混在一起。

## 7. 私有 MyWiki Plugin 套件

新增私人 Plugin 結構：

- `.agents/plugins/marketplace.json`
- `plugins/mywiki/.codex-plugin/plugin.json`
- `plugins/mywiki/.mcp.json`
- `plugins/mywiki/skills/mywiki/SKILL.md`
- `tests/mywiki-plugin-package.test.js`

目的原本是讓 ChatGPT/Codex 透過 MyWiki MCP 查詢、閱讀與有限整理私人資料。
套件仍在 repo，但使用者後來在 ChatGPT 刪除／重建 Skill 與通道，ChatGPT 實際
對話仍沒有載入 MyWiki 工具。

## 8. MCP OAuth 2.1 變更

### 8.1 已實作的伺服器能力

`mcp/src/oauth.js` 新增：

- OAuth protected-resource metadata。
- Authorization-server metadata。
- Dynamic Client Registration（DCR）。
- Authorization Code flow。
- PKCE S256。
- access token 與 refresh token。
- `mywiki:read`／`mywiki:write` scope。
- 授權頁 PIN 驗證、CSRF、防暴力嘗試 rate limit。
- 一次性 authorization code 儲存在 D1，避免 code replay。
- OAuth artifact 由既有 `MCP_PIN` 衍生簽章；旋轉 PIN 會使舊 client/token 失效。
- 保留既有 query PIN、`x-pin`、Bearer PIN 相容，避免 Claude Code 舊連線被破壞。

### 8.2 ChatGPT 工具 metadata

27 支 MCP 工具的 `tools/list` 現在會公布：

- `name`
- 中文 `title`
- `description`
- 明確 `inputSchema`
- `annotations.readOnlyHint`
- `annotations.destructiveHint`
- `annotations.openWorldHint`

`delete_folder` 標示為 destructive；寫入工具不標成 read-only。這些 metadata 是
ChatGPT Plugin 掃描器所需，不能再在 `tools/list` mapper 中剝掉。

### 8.3 內嵌 OAuth Cookie

授權 CSRF cookie 從 `SameSite=Lax` 改為：

`HttpOnly; Secure; Path=/; SameSite=None; Partitioned`

原因是 ChatGPT 可能在分區／內嵌瀏覽器環境開啟 consent page；Lax cookie 在跨站
POST 時可能不送出，造成 `CSRF validation failed`。雙提交 CSRF token 檢查仍保留。

### 8.4 目前結論：ChatGPT 接入仍失敗

伺服器 OAuth targeted tests、tool metadata tests 與 Cloudflare 部署均成功，但實際
ChatGPT 對話中：

- MyWiki、Fieldlog、MedAPI 可用工具數皆為 0。
- 系統反而選到 Notion，Notion 不是 MyWiki。
- 使用者輸入 PIN 後曾停在 consent page，也遇過 CSRF error。
- 因此目前不能宣稱 ChatGPT 已能存取 MyWiki。

若未來重啟排查，**不要再從重寫 OAuth 開始**。先取得 ChatGPT Plugins 頁面的
「工具掃描／應用程式動作」錯誤或原始 MCP request/response logs，確認工具在哪一層
被拒絕。沒有這份證據前繼續改 Worker 只會消耗成本。

## 9. MCP 權限模型

目前 MCP 是 read-mostly：

- 大部分工具唯讀。
- 4 支 append-only：`create_fieldlog_entry`、`create_fieldlog_attachment`、
  `create_relation`、`add_synonym`。
- 4 支資料夾整理工具：`update_folder`、`move_folder`、`move_entry`、
  `delete_folder`。
- 整理工具只能改分類位置、資料夾 metadata 或把子樹移入垃圾桶，不可改寫記事／
  附件實際內容。
- Wiki 正文仍走 git diff + 人工審核，不允許 MCP 直接寫入正式知識條目。

## 10. 部署變更

- 新增 `.github/workflows/deploy-mcp.yml`。
- push 到 `codex/kiwi-integration` 且變更 `mcp/**` 等指定路徑時，自動用
  `wrangler-action` 部署 `medapi-mcp`。
- deploy command 使用 `deploy --keep-vars`，不得移除 `--keep-vars`，否則 Dashboard
  上的 Secret/Variable 有被清掉的風險。
- fieldlog 正式 UI 已部署到 v110；MCP 最新 OAuth/Cookie 修正已部署到 `0e92cd0`。

## 11. 本輪提交清單

| Commit | 內容 |
|---|---|
| `e4c7f51` | 桌機檔案總管、記事階層、60 天垃圾桶、MCP 資料夾整理 |
| `076ff72` | v110 統一資料夾內容，不再拆成三種區塊 |
| `85d6816` | 私有 MyWiki Plugin/Skill 套件 |
| `92b9e17` | MCP OAuth 2.1 |
| `9f7b9f0` | OAuth 錯誤頁與診斷資訊 |
| `97fc31d` | ChatGPT 所需 tool title/annotations |
| `0e92cd0` | ChatGPT 內嵌 OAuth cookie 相容性 |

查看完整範圍：

```bash
git log --reverse --oneline fa9485c..0e92cd0
git diff --stat fa9485c..0e92cd0
```

## 12. 測試與已知風險

### 已新增／加強的測試

- `tests/fieldlog-explorer-trash-v109.test.js`
- `tests/mywiki-plugin-package.test.js`
- `tests/mcp-auth-diagnostics.test.js`
- `tests/mcp-404-json-body.test.js`
- `tests/fieldlog-home-toolbar.test.js`

本輪最後一次 OAuth targeted test 為 7/7 通過。v110 檔案總管相關新增測試曾為
17/17 通過。完整舊 MCP suite 曾有既有 mock／舊「收件匣」字串等不相關失敗，
不能把 targeted tests 通過誤寫成「全 repo 測試全綠」。接手後應先跑：

```bash
npm run check
npm test
```

### 接手時優先檢查

1. `HANDOVER.md`／`mcp/README.md` 與現況的 OAuth、工具數、部署方式是否一致。
2. 所有 search/list/get/export/MCP query 是否都排除 `deleted_at <> ''`。
3. 巢狀 entries 是否在根清單被重複顯示，搬移時整棵子樹 `folder_id` 是否一致。
4. 60 天 purge 的 R2 部分失敗、重試與並發是否保持 idempotent。
5. sync-managed entries 被丟進垃圾桶後，來源同步不得自動復活或重建它們。
6. service worker cache 與 UI v110 四處版本是否一致。
7. 桌機 grid/list/details 與手機 list 的真機回歸。
8. 拖放事件 bubbling 與內部 MIME + Files 同時存在時的優先順序。

## 13. 不要做的事

- 不要把「待分類」重新當成第一階資料夾。
- 不要在刪除父項時把子項安全上移。
- 不要把記事拖到記事改成 destructive merge。
- 不要拆散錄音／多附件資料包。
- 不要讓外部檔案因目前所在頁面而直接歸檔；只有拖到既有記事才是附加。
- 不要為了 ChatGPT 改壞 Claude Code 既有 PIN/Bearer 相容。
- 不要宣稱 ChatGPT MCP 已完成；目前證據是未載入任何 MyWiki 工具。
- 不要把 PIN、Cloudflare Token、GitHub Token 寫入本文或任何 commit。

