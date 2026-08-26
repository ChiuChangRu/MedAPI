# MyWiki Clip（Chrome／Edge）

## 安裝

1. 解壓縮 `mywiki-clip-v1.zip`。
2. Chrome 開啟 `chrome://extensions`；Edge 開啟 `edge://extensions`。
3. 開啟「開發人員模式」，選「載入未封裝項目」，指定解壓縮後的資料夾。
4. 先登入 MyWiki，再開啟想保存的網頁。
5. 點工具列的 MyWiki Clip，按「Clip 到待分類」。

## 保存規則

- 優先把目前已顯示的頁面列印成 PDF，因此登入後頁面也能保存。
- Chrome 不允許列印、頁面受限制或 PDF 超過 15MB 時，自動改存已移除腳本與表單的 HTML。
- 標題、正文、來源網址與剪藏時間一定寫入 MyWiki，供搜尋與 AI 整理。
- 剪藏期間彈出視窗會顯示整理、PDF、上傳與完成進度。

## 權限說明

- `activeTab`／`scripting`：只在你按下 Clip 時讀取目前分頁。
- `debugger`：呼叫 Chrome 的列印為 PDF 指令；完成後立即解除連線。
- `storage`：保存 MyWiki 網址與選填 PIN。
