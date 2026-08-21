# MyWiki v131 資安強化與單頁分享報告

日期：2026-08-21  
範圍：僅 MyWiki／fieldlog；不處理 Medtec 展場系統。

## 結論

v131 將原本「共用 PIN 存在 localStorage，且檔案網址攜帶 `?pin=`」改為過渡期安全 Session，並加入 Cloudflare Access JWT 驗證介面。另建立獨立的 `share` Worker，公開分享只有唯讀快照權限，無法呼叫 MyWiki 的搬移、刪除、AI 或管理 API。

## 已完成

### 私人 MyWiki

- PIN 登入成功後改發 12 小時 `__Host-myw_session` Cookie。
- Cookie 使用 `HttpOnly; Secure; SameSite=Strict; Path=/`。
- 瀏覽器會刪除舊的 `fieldlog_pin` localStorage。
- 檔案、PDF、圖片與匯出網址不再產生 `?pin=`。
- 同一來源 10 分鐘內失敗 5 次，暫停登入 15 分鐘。
- 加入 Cloudflare Access RS256 JWT 簽章、issuer、audience、有效期限與 Email 白名單驗證。
- Access 啟用後，PIN Session 端點自動關閉，避免形成第二個繞過入口。
- 全站補上 HSTS、nosniff、Referrer-Policy、X-Frame-Options 與 Permissions-Policy。

### 單頁分享

- 分享網址格式：`https://share.gogoyankee.workers.dev/s/{256-bit token}`。
- D1 只保存 token 的 SHA-256，不保存可使用的原始 token。
- 預設建立快照，不會因 MyWiki 後續修改而意外增加公開內容。
- 可選 1～30 天期限、是否包含附件、是否顯示下載入口。
- 可撤銷，並記錄開啟次數與最後開啟時間。
- 分享 Worker 只接受 GET／HEAD。
- 分享站使用 `no-store`、`noindex`、CSP、禁止 iframe 嵌入及關閉相機／麥克風／定位。
- 公開附件必須同時存在於該分享快照的白名單；不能靠修改附件 ID 讀取其他 R2 物件。

## Cloudflare Access 切換狀態

程式已支援 Access，但正式切換仍需要 Cloudflare Zero Trust 建立 Access Application 後取得以下兩個值：

- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`

白名單 Email 必須存成 Worker Secret／Variable `ACCESS_ALLOWED_EMAILS`，不得寫進公開 GitHub。兩個 Email 以逗號分隔。當 `ACCESS_TEAM_DOMAIN` 與 `ACCESS_AUD` 同時存在時，Worker 會拒絕舊 PIN 與 PIN Session，只接受通過 Access 且在白名單內的 Email。

## 注意事項

- 「禁止下載」只能移除正常下載入口，無法阻止已能在螢幕看到內容的人截圖或使用瀏覽器工具另存；介面不可宣稱 DRM。
- 過渡期仍保留後端舊 `x-pin`／查詢 PIN 相容入口，目的是避免 Access 尚未完成時鎖死。Access 變數啟用後，這些入口不再生效。
- 分享連結本身等同臨時鑰匙；收件人可再轉傳，因此敏感資料仍應設定短期限並按需撤銷。
- Cloudflare Dashboard 還應另外建立登入與高成本 API 的 Rate Limiting 規則；程式內已先提供 PIN 失敗鎖定。

## 驗證

- JavaScript 語法檢查：fieldlog Worker、Access auth、前端、PDF editor、share Worker。
- `git diff --check`。
- 核心回歸與新增資安測試：56/56 通過。
- 測試涵蓋錄音分段／背景接續、資料夾直接歸類、預覽、效能、台北時區、Session 防竄改、URL 不含 PIN、分享 token 雜湊、到期／撤銷與 Access JWT 驗證接線。
