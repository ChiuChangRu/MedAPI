# Kiwi 分支整合稽核

> 基底：`claude/medtec-exhibitor-directory-kbs2i8`
> 比對目標：`main` 分岔後的 9 個 fieldlog commit
> 稽核日期：2026-07-22

## 結論

不需要 cherry-pick `main` 的任何 commit。7 個功能 commit 已有 Git patch 等價內容；另外 2 個分別是已存在且持續演進的初始結構，以及已被進階版本取代的 OCR 功能。直接 cherry-pick 反而可能覆蓋完整分支的 Wiki、PDF 深度處理與進階 OCR 邏輯。

## 逐項結果

| Commit | 功能 | 判定 | 處理 |
|---|---|---|---|
| `ffab4bc` | 初次加入 `fieldlog/` | 完整分支已存在且大幅演進 | 不移植 |
| `75c867b` | PWA 主畫面圖示 | patch 等價 | 保留現況 |
| `aa9a89b` | 純錄音模式 | patch 等價 | 保留現況 |
| `f8b9a9c` | 附件刪除 | patch 等價 | 保留現況 |
| `72acfcc` | 背景式錄音介面 | patch 等價 | 保留現況 |
| `754a5b9` | 採集畫面重設計 | patch 等價 | 保留現況 |
| `c443751` | 錄影／拍照／錄音獨立入口 | patch 等價 | 保留現況 |
| `4857469` | 紀錄與附件刪除 | patch 等價 | 保留現況 |
| `58dc26f` | OCR、一鍵整理、匯出 OCR | 完整分支已有進階取代版本 | 不移植較短版 |

## OCR 取代依據

完整分支保留原有照片 OCR、一鍵整理與匯出能力，並增加：

- PDF metadata 清除
- 無文字層 PDF 判定
- 單行及跨行重複偵測
- 提高 temperature 重試
- 重試失敗後去重與內容搶救
- `[看不清]` 重複清理
- Tier 2 PDF 逐頁深度處理

`cloudflare/src/imageSkill.js` 與 `fieldlog/src/imageSkill.js` 目前內容完全一致，新增自動測試防止後續分叉。

## 低風險整理

- 移除 `mcp/src/textFold.js` 中重複的繁簡映射 key，不改變既有對應結果。
- 修正 Medtec 文件與程式註解，統一說明 `TEAM_PIN` 採 fail-closed。
- 增加 Node 內建測試，涵蓋繁簡摺疊、PDF metadata、無文字 PDF、OCR 重複處理與 imageSkill 同步。
- 增加統一的語法檢查及三個 Worker Wrangler dry-run 指令。

## 未在本次處理的項目

- 不修改 Cloudflare Secret、正式 D1、R2 或部署設定。
- 不更新 compatibility date，避免在整合 PR 中混入 runtime 行為變更。
- 不加入 `nodejs_compat`；目前 Worker 未使用需要該 flag 的 Node.js 相依套件。
- 不處理正式部署 commit 查證，需由 Cloudflare Dashboard 另行確認。
