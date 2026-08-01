#!/usr/bin/env bash
# fieldlog 附件 API 煙霧測試
#
# 用法（在 fieldlog/ 目錄下執行）：
#   ./scripts/smoke-test.sh
#
# 會自己起一個本機 wrangler dev（--local，用不到真的 Cloudflare 帳號），
# 建測試資料夾／紀錄、上傳各種大小的檔案，然後逐項斷言。
# 測完自動關掉 server。本機 D1/R2 資料留在 .wrangler/ 底下，不影響線上。
#
# 注意：Workers AI 在 --local 模式不能用，所以 OCR／語音轉文字只會驗到
# 「失敗有被逐筆接住、迴圈沒有中斷」，驗不到模型真的轉出文字。

set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8788}"
PIN="smoke-test-pin"
B="http://localhost:$PORT/api"
TMP="$(mktemp -d)"
LOG="$TMP/wrangler.log"
export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1

PASS=0; FAIL=0
chk() { # chk <名稱> <實際> <預期>
  if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1))
  else printf "  \033[31m✗\033[0m %s（預期 %s，實得 %s）\n" "$1" "$3" "$2"; FAIL=$((FAIL+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# ---- 起 server（原本就有 .dev.vars 就不動它，沒有才臨時造一份）----
MADE_VARS=0
if [ ! -f .dev.vars ]; then printf 'FIELD_PIN=%s\n' "$PIN" > .dev.vars; MADE_VARS=1
else PIN="$(grep -E '^FIELD_PIN=' .dev.vars | head -1 | cut -d= -f2-)"; fi

cleanup() {
  [ -n "${WPID:-}" ] && kill "$WPID" 2>/dev/null
  [ "$MADE_VARS" = "1" ] && rm -f .dev.vars
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "啟動 wrangler dev（port $PORT）…"
npx wrangler dev --port "$PORT" --local > "$LOG" 2>&1 &
WPID=$!
for _ in $(seq 1 90); do grep -q "Ready on" "$LOG" 2>/dev/null && break; sleep 1; done
if ! grep -q "Ready on" "$LOG"; then echo "✗ server 起不來，看 $LOG"; tail -20 "$LOG"; exit 1; fi
echo

# ---- 造測試資料 ----
FID=$(curl -s -X POST -H "x-pin: $PIN" -H 'content-type: application/json' \
      -d '{"name":"煙霧測試","type":"實驗"}' "$B/folders" | grep -o '"id":[0-9]*' | cut -d: -f2)
EID=$(curl -s -X POST -H "x-pin: $PIN" -H 'content-type: application/json' \
      -d "{\"title\":\"煙霧測試紀錄\",\"folder_id\":$FID}" "$B/entries" | grep -o '"id":[0-9]*' | cut -d: -f2)

up() { # up <檔案> <檔名> <mime> → 印出 attachment id
  curl -s -X POST -H "x-pin: $PIN" -H "x-entry-id: $EID" \
       -H "x-filename: $2" -H "content-type: $3" --data-binary "@$1" "$B/upload" \
    | grep -o '"id":[0-9]*' | cut -d: -f2
}

head -c 50000   /dev/urandom > "$TMP/50k.png"
head -c 200000  /dev/urandom > "$TMP/200k.png"   # ← 舊版就是在這個尺寸開始爆
head -c 1900000 /dev/urandom > "$TMP/1900k.png"  # ← 接近 2MB 門檻上緣
{ printf '%%PDF-1.4\n'; head -c 3145728 /dev/urandom; } > "$TMP/big.pdf"

A50=$(up "$TMP/50k.png"   "50k.png"   image/png)
A200=$(up "$TMP/200k.png" "200k.png"  image/png)
A1900=$(up "$TMP/1900k.png" "1900k.png" image/png)
APDF=$(up "$TMP/big.pdf"  "big.pdf"   application/pdf)
ACJK=$(up "$TMP/50k.png"  "$(printf '%%E7%%85%%A7%%E7%%89%%87-%%E6%%B8%%AC%%E8%%A9%%A6.png')" image/png)

echo "── 認證（fail-closed）──"
chk "無 PIN → 401"   "$(code "$B/config")" 401
chk "錯 PIN → 401"   "$(code -H 'x-pin: nope' "$B/config")" 401
chk "正確 PIN → 200" "$(code -H "x-pin: $PIN" "$B/config")" 200

echo "── raw：inline 模式各尺寸（這組就是抓到 bug 的關鍵）──"
chk "50KB  inline → 200" "$(code -H "x-pin: $PIN" "$B/attachments/$A50/raw?mode=inline")" 200
chk "200KB inline → 200" "$(code -H "x-pin: $PIN" "$B/attachments/$A200/raw?mode=inline")" 200
chk "1.9MB inline → 200" "$(code -H "x-pin: $PIN" "$B/attachments/$A1900/raw?mode=inline")" 200

echo "── raw：base64 內容完整性 ──"
curl -s -H "x-pin: $PIN" "$B/attachments/$A1900/raw?mode=inline" \
  | python3 -c "import sys,json,base64;open('$TMP/out.bin','wb').write(base64.b64decode(json.load(sys.stdin)['data']))" 2>/dev/null
if cmp -s "$TMP/1900k.png" "$TMP/out.bin"; then chk "1.9MB base64 往返與原檔一致" ok ok
else chk "1.9MB base64 往返與原檔一致" mismatch ok; fi

echo "── raw：url 模式與邊界 ──"
chk "大檔 url → 200"      "$(code -H "x-pin: $PIN" "$B/attachments/$APDF/raw?mode=url")" 200
chk "不存在附件 → 404"    "$(code -H "x-pin: $PIN" "$B/attachments/999999/raw")" 404
chk "page 用在非 PDF → 400" "$(code -H "x-pin: $PIN" "$B/attachments/$A50/raw?page=2")" 400
chk "page 用在 PDF → 200"   "$(code -H "x-pin: $PIN" "$B/attachments/$APDF/raw?page=2")" 200

echo "── 簽名網址 ──"
S=$(curl -s -H "x-pin: $PIN" "$B/attachments/$APDF/raw?mode=url" | sed 's/.*"url":"//;s/".*//')
case "$S" in http*) chk "回傳完整網址（非相對路徑）" ok ok;; *) chk "回傳完整網址（非相對路徑）" "$S" ok;; esac
chk "有效簽名 → 200" "$(code -H "x-pin: $PIN" "$S")" 200
chk "篡改簽名 → 403" "$(code -H "x-pin: $PIN" "$(echo "$S" | sed 's/sig=./sig=0/')")" 403
chk "過期簽名 → 403" "$(code -H "x-pin: $PIN" "$(echo "$S" | sed 's/expires=[0-9]*/expires=1000000000/')")" 403
chk "簽名但無 PIN → 401（簽名不等於可對外分享）" "$(code "$S")" 401

echo "── 中文檔名 ──"
SC=$(curl -s -H "x-pin: $PIN" "$B/attachments/$ACJK/raw?mode=url" | sed 's/.*"url":"//;s/".*//')
chk "中文檔名簽名網址可下載 → 200" "$(code -H "x-pin: $PIN" "$SC")" 200

echo "── 批次處理 ──"
chk "缺參數 → 400"    "$(code -X POST -H "x-pin: $PIN" -H 'content-type: application/json' -d '{}' "$B/batch/process-attachments")" 400
chk "folder_id → 200" "$(code -X POST -H "x-pin: $PIN" -H 'content-type: application/json' -d "{\"folder_id\":$FID}" "$B/batch/process-attachments")" 200
chk "entry_id → 200"  "$(code -X POST -H "x-pin: $PIN" -H 'content-type: application/json' -d "{\"entry_id\":$EID}" "$B/batch/process-attachments")" 200
# 單項失敗不中斷：本機 AI 不可用 → 每張都會失敗，但每張都要有回報
N=$(curl -s -X POST -H "x-pin: $PIN" -H 'content-type: application/json' -d "{\"folder_id\":$FID}" \
    "$B/batch/process-attachments" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['results']))" 2>/dev/null)
chk "4 張照片全部逐筆回報（失敗不中斷迴圈）" "$N" 4

echo "── 既有功能迴歸 ──"
chk "GET /folders → 200"       "$(code -H "x-pin: $PIN" "$B/folders")" 200
chk "GET /entries → 200"       "$(code -H "x-pin: $PIN" "$B/entries?folder_id=$FID")" 200
chk "GET /export/folder → 200" "$(code -H "x-pin: $PIN" "$B/export/folder/$FID")" 200
chk "PUT /attachments → 200"   "$(code -X PUT -H "x-pin: $PIN" -H 'content-type: application/json' -d '{"category":"設備"}' "$B/attachments/$A50")" 200
chk "POST /upload 缺 entry → 400" "$(code -X POST -H "x-pin: $PIN" -H 'content-type: image/png' --data-binary '@/dev/null' "$B/upload")" 400

echo
if [ "$FAIL" -eq 0 ]; then printf "\033[32m════ 全部通過：%d 項 ════\033[0m\n" "$PASS"
else printf "\033[31m════ PASS=%d  FAIL=%d ════\033[0m\n" "$PASS" "$FAIL"; fi
echo "（未涵蓋：Workers AI 實際 OCR／語音轉文字 — 本機 binding 不支援，需 staging 驗證）"
[ "$FAIL" -eq 0 ]
