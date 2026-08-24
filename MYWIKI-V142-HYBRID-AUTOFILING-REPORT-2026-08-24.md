# MyWiki v142：B 模式每日混合分類

日期：2026-08-24

## 結果

- 每日 cron（UTC 18:00／台灣 02:00）只掃描「待分類」內新增或內容更新過的根記事，每次最多 25 筆。
- 人工核准的關鍵字規則或唯一資料夾名稱命中優先；否則用 Cloudflare Workers AI 的 BGE-M3 向量與 Llama 3.2 3B 判定。
- 規則唯一命中，或向量與 Llama 在分數及差距都達門檻時，才自動搬動。
- 只有單一判斷、信心不足或兩者不同意時，不自動搬；前臺只顯示「套用／忽略」。
- 自動搬動顯示「確認／復原」，每個狀態都寫入 D1 與 append-only history。
- 沒有新增手動整理按鈕；後臺另保留受既有登入保護的補跑端點 `/api/admin/run-hybrid-filing`。
- 每日分類的候選 SQL 強制限定 `folder_id = 待分類`，已在正式資料夾的內容即使更新也不會被排程搬動。
- 既有正式資料只可由明確命令呼叫 `/api/admin/review-existing-filing` 做一次性母體整理；每筆只評估一次，未達高信心不搬。

## 安全邊界

1. 目的地只能是 D1 內既有且未刪除、沒有系統 role 的資料夾 ID。
2. 分類流程沒有建立、刪除、改名或移動資料夾的 SQL。
3. `source_updated_at` 未改變就不重跑，避免每日重複扣 Workers AI 額度。
4. 人工搬動會把判定標成 `overridden`；復原會鎖住同一內容，隔天不會再次自動搬。
5. 執行前沿用現有 Workers AI 軟預算檢查，模型呼叫走既有 AI Gateway（若已設定）。
6. 母體整理沒有掛入 cron，原資料夾保存在 `previous_folder_id`，可逐筆復原。

## 資料模型

新增 `filing_suggestions`，一筆記事只保留最新判定，狀態包含：

- `pending`
- `auto_applied`
- `accepted`
- `rejected`
- `confirmed`
- `undone`
- `overridden`
- `unresolved`

## 驗證

- 新增決策門檻測試、模型白名單測試、排程／路由結構測試。
- 使用 Node 內建真實 SQLite 執行 schema、候選查詢、upsert 與搬動 SQL，驗證規則自動搬、AI 單獨判斷只留建議、相同內容隔日不重跑。
- v142 前端、Worker、HTML 與 Service Worker 快取版本一致。
