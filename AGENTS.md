# AI 維護入口

修改本 repo 前必須依序閱讀：

1. [MAINTENANCE.md](MAINTENANCE.md)：跨 AI、跨系統的共同維護與部署規則。
2. [GPT-HANDOVER.md](GPT-HANDOVER.md)：架構、資料表、API、測試與部署細節。
3. 本次涉及目錄內的 README。

目前 `medtec-2026`、`fieldlog`、`medapi-mcp` 都是現役系統。不得因整理架構而停用、改成唯讀、改網址、刪資料或直接切換正式流量。

若文件與程式碼不一致，以程式碼與測試為準，先在 PR 內修正差異；不得直接在正式環境試錯。
