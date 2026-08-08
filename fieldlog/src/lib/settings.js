/**
 * 簡單的 key-value 應用設定，存 D1。
 *
 * 用途：使用者在前台自己就能調整的行為參數（目前只有「暫存區放幾天後
 * AI 自動歸類」）。跟 Worker 的環境變數（例如舊的 AUTO_FILE_DAYS）不一樣——
 * 環境變數要進 Cloudflare Dashboard 改、重新部署才生效，一般使用者碰不到；
 * 這裡的設定改了立刻生效，且不需要工程介入。
 *
 * 沿用專案既有的「SELECT 有沒有 → 有就 UPDATE、沒有就 INSERT」寫法（folders／
 * categories 都是這樣），不用 D1 的 ON CONFLICT，方便測試裡的假 DB 直接比對
 * SQL 字串。
 */

export async function getSetting(db, key) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(db, key, value, timestamp) {
  const existing = await db.prepare("SELECT key FROM settings WHERE key = ?").bind(key).first();
  if (existing) {
    await db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?").bind(String(value), timestamp, key).run();
  } else {
    await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(key, String(value), timestamp).run();
  }
}
