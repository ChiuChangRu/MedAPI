# 交接文件（給接手的 Claude / 開發者）

> 這份文件讓你在**完全不知道前情**的情況下，接手維護這整套系統。
> 讀完這份＋下面列的四份文件，你就有全貌。
> **本檔案刻意不含任何密碼/PIN 的實際值**——那些是私下另外交付的（見第一節）。

---

## 〇、30 秒總覽

一套「醫療器材塗層」領域的**個人知識採集系統**，三個獨立的 Cloudflare
Worker ＋一個 git 版控的知識庫：

| 子系統 | 是什麼 | 目錄 | 線上網址 |
|---|---|---|---|
| **fieldlog（隨身記）** | 個人現場採集：錄影/拍照/錄音/速記，AI 轉文字 | `fieldlog/` | `https://fieldlog.gogoyankee.workers.dev` |
| **medtec-2026（參展系統）** | 8 人團隊共筆：585 家展商名單、拜訪紀錄、附件 | `cloudflare/` | `https://medtec-2026.gogoyankee.workers.dev` |
| **medapi-mcp（MCP 問答層）** | 唯讀，讓 claude.ai 跨三來源自然語言查詢 | `mcp/` | `https://medapi-mcp.gogoyankee.workers.dev` |
| **策略地圖 Wiki（知識層）** | 純 Markdown、git 版控的技術知識條目 | `fieldlog/public/wiki/` | `.../wiki.html`（隨身記內，PIN 保護） |

還有兩個參展系統的平行舊版本（`docs/` GitHub Pages 靜態版、`app/`
FastAPI 版），目前主線是 `cloudflare/`，那兩個少碰。

---

## 一、接手前必做：三種存取權限（本人 gogoyankee 要授予）

接手的帳號要能動這套系統，需要三塊獨立的存取權，**由原持有人操作授予，
密碼/值私下給，不要寫進任何會分享的檔案**：

1. **GitHub 原始碼**：repo `ChiuChangRu/MedAPI`。把接手帳號加為
   collaborator（Settings → Collaborators）。開發分支是
   `claude/medtec-exhibitor-directory-kbs2i8`（見第五節）。
2. **Cloudflare 帳號**（三個 Worker、D1、R2 都在這帳號底下，帳號代稱
   `gogoyankee`）：改**程式碼**只要 GitHub 就夠（推 code 會自動部署）；
   但要看**部署狀態、改 Secret、查 D1 Console、看 R2 檔案**，需要
   Cloudflare 儀表板存取——用 Cloudflare 的 **Members**（Manage
   Account → Members）邀請，或由原持有人代為操作。
3. **MCP 問答連接器**（要在 claude.ai 用自然語言查live資料時）：
   連接器 URL 是 `https://medapi-mcp.gogoyankee.workers.dev/mcp?pin=<MCP_PIN>`。
   把 `<MCP_PIN>` 的實際值私下給接手人，讓他在自己的 claude.ai →
   Settings → Connectors → Add custom connector 貼上。

> **要私下交付的密碼清單（值不寫在這）**：`FIELD_PIN`（隨身記登入＋wiki）、
> `TEAM_PIN`（參展系統登入）、`MCP_PIN`（MCP 端點）。選用的還有 LINE 的
> 兩個 token（見 `cloudflare/README.md`）。

---

## 二、先讀這四份文件（照順序）

| 文件 | 講什麼 |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 工程決策與全貌：為什麼三系統不合併、MCP 只做唯讀、wiki 走 git 人審。含「待解問題」清單 |
| [`DATA-MODEL.md`](DATA-MODEL.md) | 資料存哪裡（R2 檔案／D1 文字）、資料表欄位、四種整理狀態、PDF 三種辨識差異、查證 SQL |
| [`SECOND-BRAIN.md`](SECOND-BRAIN.md) | 給人看的操作手冊：採集→整理→更新 wiki→claude.ai 問答的日常流程 |
| 各子目錄 `README.md` | `cloudflare/`、`fieldlog/`、`mcp/`、`fieldlog/public/wiki/` 各有一份，含各自的部署步驟 |

---

## 三、Cloudflare 資源清單（名稱，非機密值）

| 類型 | 名稱 | 綁在哪 | 備註 |
|---|---|---|---|
| Worker | `fieldlog` | root `fieldlog/` | 隨身記後端＋前端靜態資產 |
| Worker | `medtec-2026` | root `cloudflare/` | 參展系統，含每日 LINE 摘要 cron |
| Worker | `medapi-mcp` | deploy `mcp/wrangler.jsonc` | MCP 唯讀層，無自己的儲存 |
| D1 資料庫 | `fieldlog` | id `41483c93-9398-4be6-a670-a3120c880781` | fieldlog Worker＋medapi-mcp 共綁 |
| D1 資料庫 | `medtec-2026` | id `bbb39534-bcf7-45b3-b068-60be5c3b198b` | medtec Worker＋medapi-mcp 共綁；medtec 另唯讀共綁 fieldlog 庫做「今日 AI 用量」 |
| R2 bucket | `fieldlog-files` | fieldlog Worker（binding `FILES`） | 隨身記的照片/錄音/PDF |
| R2 bucket | `medtec-2026-files` | medtec Worker（binding `FILES`） | 參展系統的附件 |
| Workers AI | binding `AI` | 三個採集 Worker 都有 | Whisper 轉錄、Llama Vision OCR、toMarkdown |
| Service Binding | `FIELDLOG`／`MEDTEC` | medapi-mcp → 另兩個 Worker | MCP 讀 wiki／展商主檔用（不能用 fetch 打 workers.dev） |

**各 Worker 需要的 Secret／Variable（值私下給）**：
- `fieldlog`：`FIELD_PIN`
- `medtec-2026`：`TEAM_PIN`；選用 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`
- `medapi-mcp`：`MCP_PIN`、`FIELD_PIN`（與 fieldlog 同值，讀 wiki 用）

---

## 四、部署模型（重要，跟一般 CI 不同）

- 三個 Worker 都是 **Cloudflare 連 GitHub 的自動部署**：**推 code 到開發
  分支 → Cloudflare 自動 build＋部署**，不需要手動跑任何指令。
- `medapi-mcp` 比較特別：它的 Deploy command 是
  `npx wrangler deploy --config mcp/wrangler.jsonc`（因為這個簡化流程
  沒有獨立的 Root directory 欄位）。另兩個是 root directory 設成
  `fieldlog/`、`cloudflare/`。
- **前端是網路優先的 PWA**：改了 `public/app.js` 等靜態檔，使用者要
  **重新整理頁面**才會載到新版（已開著的分頁仍跑舊記憶體裡的程式）。
- **⚠️ 目前狀態（2026-07-19）**：GitHub 正在故障，GitHub→Cloudflare
  的部署 webhook 失靈中。最後一個 fieldlog 的部署還停在 Tier 2 那版
  （version `b9923a11`），「背景錄音」的修正已 push 但**還沒部署**。
  GitHub 恢復後會自動補上，或在 Cloudflare Deployments 頁手動 Retry。

---

## 五、開發流程

- **開發分支**：`claude/medtec-exhibitor-directory-kbs2i8`（一直在這條上
  開發、commit、push；不要直接推 main）。
- **改完就 push**，Cloudflare 自動部署（見第四節）。
- **commit 慣例**：清楚的英文標題＋內文說明「為什麼」，結尾帶
  `Co-Authored-By:` 與 `Claude-Session:` 兩行（照現有 commit 的格式）。
- **測試**：專案沒有正式 test 目錄。過程中的驗證是寫**臨時 node 腳本**
  跑（mock D1／fetch，驗 worker 邏輯），這些腳本在暫存區、**沒有進 repo**。
  接手時若要回歸測試，照同樣模式（`node --check` 語法檢查＋ mock 出
  `env.DB`/`env.FILES` 打 `worker.fetch(req, env)`）自己重建即可。
- **共用模組**：`imageSkill.js`（照片 OCR／鬼打牆處理／PDF metadata 剝除）
  正本在 `cloudflare/src/`，用 `cp` 同步到 `fieldlog/src/`——改一邊要
  記得同步另一邊（兩份必須一致）。
- **兩系統邏輯要一致**：使用者明確要求「參展系統」與「個人記事」的
  附件/整理邏輯保持同步，改一邊通常要照著改另一邊。

---

## 六、進行中／待辦／已知限制（接手最需要知道的）

**進行中（卡在部署）**
- **背景錄音**：`fieldlog` 切分頁不中斷錄音的修正已完成並 push，卡 GitHub
  故障未部署。**只針對桌機 Chrome**（iOS 系統層不允許背景錄音，範圍外）。
  部署後要在真桌機 Chrome 驗證（錄音→切分頁→切回→停止＝一段連續、
  無缺口無重複）。同樣機制的參展系統「採集模式」**還沒改**。
- **Tier 2 深度處理**（PDF 逐頁 render 成圖再 OCR，手動觸發）：已完成
  並 push，但 pdf.js 那半邊**沒辦法在無瀏覽器環境測**，要真桌機驗證。

**待辦／缺口**
- **前台顯示端 PDF metadata 即時剝除**：MCP 已即時剝，但**前台顯示**舊
  PDF 仍會show出 metadata（除非對該 PDF 按「重抄」）。可補一個前台
  render-time 剝除（曾提議、未做）。
- **同義詞／語意搜尋**：簡繁摺疊已做（`mcp/src/textFold.js`），但「抗結痂
  ↔抗結晶」這種**同義詞**搜不到。正解是語意向量搜尋，工程量大，先擱。
  ⚠️ 使用者明確反對「手寫同義詞字典」那種為單一問題補的做法——要做就做
  通用的系統機制。
- **隨身記 Notion 自動同步**：`folders` 表有 `notion_*` 欄位、
  `parseNotionPageId()` 也寫好了，但**沒有 API 路徑真的呼叫**，等於死代碼；
  目前是人工把 AI 彙整報告貼進 Notion。要嘛補完、要嘛清掉。
- **LitDB（文獻／專利）**：尚未建置，只在 wiki `C2` 條目當待讀清單。
- **參展系統既有待辦**：`docs/app.js` 的 `TEAM_EMAIL` 還是佔位字串；
  GitHub Pages 靜態版部署未開；`app/` FastAPI 版後台無登入驗證。

**設計鐵律（別踩）**
- MCP **一律唯讀**，只有 SELECT／fetch，不寫入。要改資料走各前台。
- wiki 收錄**一律人審 git diff**，AI 不直接寫入生產內容。
- Tier 2 **絕不背景全庫批次**，只處理使用者手動指定的單一 PDF。
- **不為單一問題／單一公司寫程式**——改就改通用的系統層。
- Cloudflare Workers AI 有**每日免費 10,000 Neurons 額度**（帳號已升級
  Workers Paid，超過按量計費）；批次整理會顯示今日用量，額度用完會回
  錯誤碼 `4006`，程式碼多處有針對它中止的保護。

---

## 七、快速上手檢查清單

1. [ ] 拿到 GitHub collaborator 權限，clone repo，切到開發分支
2. [ ] 拿到 Cloudflare 儀表板存取（看部署/改 Secret/查 D1）
3. [ ] 拿到三個 PIN 的實際值（私下），把 MCP 連接器接上自己的 claude.ai
4. [ ] 讀完第二節那四份文件
5. [ ] 確認 GitHub 故障是否已解除、fieldlog 是否部署到最新版
6. [ ] 真桌機 Chrome 驗證背景錄音＋Tier 2 深度處理這兩個待驗證項

## 更新日誌
- 2026-07-19｜初版交接文件
