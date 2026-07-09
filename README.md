# Medtec China 2026 展商導覽與需求留言網頁

給同事在出發前瀏覽上海 Medtec China 2026（2026/9/1-9/3，上海新國際博覽中心 N1-N4 館）展商名單、依分類篩選產品，並直接留言洽談需求，統一由窗口彙整後轉達給廠商或安排展中拜訪。

本 repo 有兩個版本，用途不同：

| | `docs/`（靜態版） | `app/`（完整版） |
|---|---|---|
| 有沒有網址 | ✅ 用 GitHub Pages，免架站，公開網址 | ❌ 需要自己找主機執行才有網址 |
| 留言方式 | 開啟 Email 草稿寄給窗口 | 存進資料庫，後台可彙整、匯出 CSV |
| 需要的設定 | Repo 設定裡開一次 GitHub Pages（見下方） | 需要一台能跑 Python 的主機 |

**沒有主機資源時，用 `docs/` 就好，馬上有網址可以分享。**

## 🚀 取得公開網址：開啟 GitHub Pages（一次性設定，30 秒）

1. 到這個 repo 的 **Settings → Pages**
2. Source 選 **Deploy from a branch**
3. Branch 選這個分支（`claude/medtec-exhibitor-directory-kbs2i8`，或合併進 `main` 後選 `main`），資料夾選 **/docs**
4. 存檔後等 1-2 分鐘，網址會出現在同一頁面（通常是
   `https://chiuchangru.github.io/MedAPI/`）

之後每次 push 更新 `docs/` 內容，網址會自動更新，不需要重新設定。

### 留言信箱要換成真的

`docs/app.js` 第一行 `TEAM_EMAIL` 目前是 `your-team@example.com` 佔位字串，
請改成實際負責彙整需求的窗口信箱，例如：

```js
const TEAM_EMAIL = "your-real-team@company.com";
```

## ⚠️ 目前資料狀態（請務必先讀）

`app/data/exhibitors.json` 與 `docs/data/exhibitors.json` 都是**示範資料
（8 家假想廠商）**，不是官方真實名單。

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
3. 執行匯入腳本（會同步更新 `app/data/` 與 `docs/data/` 兩份資料）：
   ```bash
   python3 scripts/import_exhibitors.py 真實展商名單.csv
   ```
4. `git commit` + `push`，GitHub Pages 網址會自動更新為真實名單。

## 功能

- **展商導覽首頁**：關鍵字搜尋、分類篩選（chips）、展館篩選、
  卡片顯示公司名稱、攤位號、產品標籤與簡介。
- **留言洽談**：每張卡片可開啟表單，同事填寫姓名／部門／聯絡方式／需求內容。
  - 靜態版（`docs/`）：送出後開啟 Email 草稿，內容已預填好，寄給 `TEAM_EMAIL`。
  - 完整版（`app/`）：送出後存進資料庫，`/admin.html` 後台可彙整、標記處理狀態、匯出 CSV。

## 技術架構

- **靜態版 `docs/`**：純 HTML/CSS/JS，資料直接讀取同目錄下的
  `data/exhibitors.json`，不需要任何後端或建置流程，GitHub Pages 直接可跑。
- **完整版 `app/`**：Python FastAPI（`app/main.py`），以 SQLite 儲存留言
  （`app/data/inquiries.db`，首次啟動自動建立，已加入 `.gitignore`）。
- 展商資料共用格式：`app/data/exhibitors.json` / `docs/data/exhibitors.json`
  （可用 `scripts/import_exhibitors.py` 一次同步匯入真實名單）。

## 完整版（`app/`）本機執行

```bash
pip install -r requirements.txt
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

開啟 http://localhost:8000 即可看到展商導覽頁；後台在
http://localhost:8000/admin.html。

若要讓同事直接用完整版（含後台彙整），需要部署到一台可長開的主機或容器
（公司內部伺服器、Railway、Render、Fly.io 等），用上面的 uvicorn 指令常駐執行。
**後台目前沒有登入驗證**，正式對外分享前建議加上簡單的帳號密碼或內部網路限制。

## 目前限制與待辦

- [ ] 用真實官方展商名單取代示範資料（見上方「取得真實名單」）
- [ ] `docs/app.js` 的 `TEAM_EMAIL` 換成真實窗口信箱
- [ ] 在 repo Settings → Pages 開啟一次靜態版部署（見上方步驟）
- [ ] 完整版後台加上登入驗證，避免留言內容外流
