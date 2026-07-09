# Medtec China 2026 展商導覽與需求留言網頁

給同事在出發前瀏覽上海 Medtec China 2026（2026/9/1-9/3，上海新國際博覽中心 N1-N4 館）展商名單、依分類篩選產品，並直接留言洽談需求，統一由窗口彙整後轉達給廠商或安排展中拜訪。

## ⚠️ 目前資料狀態（請務必先讀）

本專案內建的 `app/data/exhibitors.json` 是**示範資料（8 家假想廠商）**，不是官方真實名單。

原因：這個開發環境的網路白名單擋掉了對外部網站（包含官方展商目錄
`exhibitors.informamarkets-info.com` 及 `en.medtecchina.com`）的直接連線，
系統本身無法自動爬取真實名單。功能與介面都已完整可用，**只差真實資料**。

### 取得真實名單並匯入的方式

1. 用瀏覽器登入官方展商目錄：
   https://exhibitors.informamarkets-info.com/event/2026Medtec
   通常可用篩選/匯出功能，或用「另存頁面」「複製表格」等方式，將公司名稱、
   攤位號、分類、產品說明整理成 CSV。
2. 依照下列欄位整理成 CSV（第一列為標題，順序不拘）：
   ```
   name_zh, name_en, booth_no, hall, country, category, tags, description, products, website
   ```
   - `category` 請填入 `app/data/exhibitors.json` 裡 `categories` 區塊的 id
     （`materials` / `electronics` / `machining` / `packaging` /
     `automation` / `testing` / `oem` / `ivd` / `digital`），
     沒有合適分類可直接在該檔案的 `categories` 陣列新增一筆。
   - `tags`、`products` 若有多個值用「;」分隔，例如 `親水塗層;導管材料`。
3. 執行匯入腳本：
   ```bash
   python3 scripts/import_exhibitors.py 真實展商名單.csv
   ```
   會直接覆寫 `app/data/exhibitors.json` 內的 `exhibitors` 陣列。
4. 重新啟動服務，網頁即顯示真實名單。

## 功能

- **展商導覽首頁**（`/`）：關鍵字搜尋、分類篩選（chips）、展館篩選、
  卡片顯示公司名稱、攤位號、產品標籤與簡介。
- **留言洽談**：每張卡片可開啟表單，同事填寫姓名／部門／聯絡方式／需求內容，
  送出後存進資料庫。
- **需求留言後台**（`/admin.html`）：列出所有留言，可標記狀態
  （待轉達／已轉達／已完成），並一鍵匯出 CSV 給負責轉達的窗口。

## 技術架構

- 後端：Python FastAPI（`app/main.py`），以 SQLite 儲存留言（`app/data/inquiries.db`，
  首次啟動自動建立，已加入 `.gitignore`）。
- 前端：純 HTML/CSS/JS（`app/static/`），不需建置流程。
- 展商資料：`app/data/exhibitors.json`（可用 `scripts/import_exhibitors.py` 匯入真實名單）。

## 本機執行

```bash
pip install -r requirements.txt
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

開啟 http://localhost:8000 即可看到展商導覽頁；後台在
http://localhost:8000/admin.html。

## 部署建議

- 內部同事使用：部署到任一台可長開的主機或容器（例如公司內部伺服器、
  Railway、Render、Fly.io 等），用 `uvicorn app.main:app --host 0.0.0.0 --port 8000`
  常駐執行，分享網址給同事即可，不需要額外前端建置流程。
- 展前僅需一次性瀏覽：也可以直接在筆電本機執行後用內部網路分享。
- **後台目前沒有登入驗證**：`/admin.html` 與 `/api/inquiries` 任何知道網址的人都能看到留言內容，
  正式對外分享前建議至少加上簡單的帳號密碼或內部網路限制（VPN / IP 白名單）。

## 目前限制與待辦

- [ ] 用真實官方展商名單取代示範資料（見上方「取得真實名單」）
- [ ] 後台加上登入驗證，避免留言內容外流
- [ ] 若要多人同時彙整留言，建議改用共用資料庫（目前 SQLite 為單機檔案）
