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
- 外部檔案拖進資料夾頁時要直接歸入目前資料夾；拖到既有記事時則附加到該記事。
- 不要為了 ChatGPT 改壞 Claude Code 既有 PIN/Bearer 相容。
- 不要宣稱 ChatGPT MCP 已完成；目前證據是未載入任何 MyWiki 工具。
- 不要把 PIN、Cloudflare Token、GitHub Token 寫入本文或任何 commit。

## 14. 2026-08-23：v134 Evernote 式閱讀工作區

使用者決定先把 MyWiki 的一般資料結構簡化，暫不實作 MD 副檔、AI 每日整理或
AI 自動分類，但介面與資料保存方式不得妨礙日後加入這些能力。

本次完成：

- 桌機左側資料夾樹可像 ChatGPT 收合／展開，狀態記在 `localStorage`；既有滑鼠
  調整欄寬功能保留。
- 桌機點選一般筆記或錄音資料包時，先在右側顯示唯讀閱讀內容，不再立刻進入
  編輯器。
- 右側閱讀欄提供「編輯」、「全欄寬閱讀／縮回」與關閉按鈕；附件仍可切換成
  圖片、PDF、HTML、文字、影音或 Office 解析文字預覽。
- 一般筆記統一使用標題＋Evernote/Word 式富文字本文；不再依資料夾 type 自動
  產生上海參展式專用欄位。
- 舊 `fields_json` 完整保留，於閱讀／編輯畫面以收合的「舊有屬性」唯讀呈現；
  儲存一般筆記時不覆寫這些舊屬性。
- `weekly_report` 仍保留既有三段式週報專用編輯器與明確儲存按鈕，避免破壞
  Claude MCP 的 `update_weekly_report` 白名單欄位流程。
- 搜尋 API、附件解析、錄音資料包、拖放搬移、資料庫 schema 均未改動。
- UI／Worker／Service Worker 版本同步為 v134。

驗證：本次相關測試 57/57 通過，`app.js` 與 Worker 語法檢查通過；全套測試仍為
既存 78 項失敗（主要是舊 SQL mock、MCP 舊字串／fixture），本次沒有把它們冒充
成全綠。新增測試為 `tests/fieldlog-unified-editor.test.js`，並加強右側閱讀與側欄
收合測試。

提交資訊：本機功能整合提交為 `3cba4a0`；因工作環境無法直接 Git push，正式
分支改由 GitHub Contents API 逐檔同步，UI／測試檔案批次最後一筆為 `ccfc3bc`，
交接文件另案提交。兩端本次 9 個功能／測試檔案已逐一以 Git blob SHA 比對一致。

## 15. 2026-08-23：v135 一般記事右欄編輯修正

v134 的閱讀模式雖然已移除依資料夾產生的專用欄位，但桌機右欄按「編輯」仍會
呼叫舊 `openEntry()`，因此畫面仍出現上海參展時期的大型 modal（合併逐字稿、
位置、來源等工具）。這是實作未完成，不是瀏覽器快取。

v135 修正如下：

- 桌機一般記事按「編輯」後，直接在右側欄切換為標題＋富文字編輯器。
- 右欄保留明確的「儲存／取消」、附件清單、上傳／插圖、拍照、錄音與錄影入口。
- 一般記事右欄主編輯畫面不再顯示合併逐字稿、位置、資料來源、關聯等舊展場工具。
- 錄音、拍照、錄影完成後，桌機回到右欄閱讀內容，不再重新開啟舊 modal。
- `weekly_report` 仍刻意沿用三段式專用表單，避免破壞週報欄位與 Claude MCP 更新
  流程；手機因沒有右側欄，暫時仍使用既有 modal 編輯。
- 舊 `fields_json`、附件、逐字稿及資料包結構均未刪除或轉換。
- UI／Worker／Service Worker 版本同步為 v135。

驗證：本次相關測試 50/50 通過，`app.js` 語法與 `git diff --check` 通過。完整
測試為 492 項、414 通過、78 項既有失敗；失敗數與 v134 相同，新增的右欄編輯
回歸測試通過。

## 16. 2026-08-23：v136 資料夾內容統一為「資料夾＋記事」

v135 的資料庫本來就是 `folders → entries → attachments`，但資料夾頁會依附件數量
把同一種 entry 顯示成三種前台物件：單一附件是檔案列、多附件／錄音是資料包卡、
純文字則是筆記列。這使畫面看起來像三套資料結構，標題也被移動／合併／刪除按鈕
壓得很窄。

v136 的處理原則：不做資料庫 migration、不搬移或改寫既有內容，只統一前台物件模型。

- 資料夾頁現在只產生兩種物件：真正的資料夾，以及統一記事 `entry-row`。
- PDF、Word、Excel、PowerPoint、圖片、影片、錄音與多附件都只是記事的附件；差異只
  反映在圖示與「文件記事／圖片記事／錄音記事／多媒體記事」摘要，不再各自套版。
- 移除作用中的 `folderFileHtml`、`recordGroupCardHtml`、`bindFileRows`、
  `bindRecordGroupCards` 與對應的舊版列表 CSS；舊有巢狀子記事仍可從詳情讀取。
- 桌機清單／詳細模式的標題取得主要彈性欄位；編輯、附件管理、重新命名、移動、合併、
  移到垃圾桶集中到每筆記事的 `⋯` 選單。
- 單一附件記事在桌機點選時仍直接開右側 PDF／圖片／Office／HTML 等預覽；一般記事與
  多附件記事開右側閱讀器，編輯由 `⋯ → 編輯記事` 進入。
- 站內記事拖曳只搬到資料夾，不再允許記事拖到記事形成新的巢狀資料包；外部 Files
  拖到既有記事仍附加，拖入資料夾空白區仍直接歸入目前資料夾。
- 整筆記事搬移仍保留復原按鈕；附件實體、OCR、逐字稿、舊 `fields_json`、搜尋索引與
  MCP 資料模型皆未改動。
- UI／Worker／Service Worker 版本同步為 v136。

驗證：本次針對性測試 24/24 通過；`npm run check`、`app.js` 語法與
`git diff --check` 通過。完整測試為 492 項、415 通過、77 項既有 SQL mock／MCP
fixture 失敗；本次未增加失敗數，並因搬移後按鈕文字統一成「復原」而修掉 1 項舊
UI 回歸測試。

## 17. 2026-08-23：v137 記事內插入圖片、錄音與檔案

v136 已把資料夾內容統一為記事，但一般記事編輯器仍只有圖片能真正插進游標位置；
錄音與 PDF／Office 等檔案雖然能成為附件，卻只顯示在文章底部。v137 補齊同一套
`entries → attachments` 架構的多媒體編輯能力，沒有新增資料表。

- 一般記事編輯區上方顯示「插入圖片／檔案、拍照附件、錄音附件、錄影附件」，不必
  捲到文章最下方才找到上傳入口。
- 圖片上傳、貼上或拖入後，會在目前游標位置插入圖片；檔案本體仍只存 R2，body
  只保存 `/api/file/...` 與 attachment id。
- 上傳音訊後，內文插入可播放的 `<audio controls>` 卡片；PDF、Word、Excel、
  PowerPoint、HTML 等一般檔案插入可開啟的附件卡片。
- 從編輯器啟動拍照或錄音時，先保存文字草稿；採集完成後再把新圖片／錄音分段引用
  寫回內文。若網路中斷而只能進離線佇列，檔案仍會保存，但在取得正式 attachment id
  前不製造假的內文引用。
- 上傳顯示筆數進度與 `<progress>`；重複檔案仍沿用既有 SHA-256 去重。
- 內文刪除圖片／附件卡只移除顯示引用，原始附件仍留在文章附件區，避免誤刪資料。
- 後端富文字白名單新增安全的 `figure.fieldlog-attachment-card` 與 `audio`，且播放器
  `src`／卡片 `data-url` 只接受站內 `/api/file/`，不能引用外部網址冒充 MyWiki 附件。
- `htmlToPlainText()` 會把卡片轉成 `[附件：檔名]`／`[錄音：檔名]`，因此既有搜尋、
  匯出與 MCP 純文字檢索仍能找到附件名稱。
- UI／Worker／Service Worker 版本同步為 v137。

驗證：富文字、附件白名單、錄音可靠性、資料夾路由與首頁 UI 等針對性測試皆通過；
完整測試總數由 492 增至 496，新加 4 項皆通過，仍保留 v136 的 77 項既有 SQL
mock／MCP fixture 失敗，未新增失敗。
