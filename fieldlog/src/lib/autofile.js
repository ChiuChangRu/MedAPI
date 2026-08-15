/**
 * 待分類區。
 *
 * 要解決的問題：現場採集當下最缺的就是時間，「先分類再記錄」在展場、實驗室
 * 根本做不到，所以東西一律先落在某個「之後再說」的地方。舊做法是收件匣
 * （folder_id IS NULL），但收件匣空的時候整個面板會從首頁消失，等於沒分類的
 * 東西直接看不見——看不見就不會被處理，堆到最後只能整批放棄。
 *
 * 改成：來不及分類的一律進「待分類」（role='staging' 的系統容器）。它不顯示
 * 在四層資料夾樹裡，但內容固定出現在首頁待分類清單，使用者之後再移動。
 *
 * （2026-08-09 移除「放滿 N 天沒人動就由 AI 自動歸類」與相關的分類規則
 * 學習機制——AI 自動歸類、規則比對、autofile_hints／autofile_corrections
 * 都拿掉，只留暫存區本身這個「看得見的待辦」概念。entries.auto_filed_at／
 * auto_filed_reason 欄位與 autofile_hints／autofile_corrections 資料表沒有
 * 跟著刪，歷史資料還在，只是不會再有新資料寫進去。）
 */

export const STAGING_FOLDER_NAME = "⏳ 待分類";
export const STAGING_FOLDER_ROLE = "staging";
export const STAGING_FOLDER_TYPE = "其他";

/** 取得（必要時建立）待分類系統容器；它不計入四層資料夾架構。 */
export async function ensureStagingFolder(db, timestamp) {
  const existing = await db
    .prepare("SELECT * FROM folders WHERE role = ? LIMIT 1")
    .bind(STAGING_FOLDER_ROLE)
    .first()
    .catch(() => null);
  if (existing) {
    if (existing.name !== STAGING_FOLDER_NAME || existing.type !== STAGING_FOLDER_TYPE || existing.parent_id) {
      await db.prepare("UPDATE folders SET name = ?, type = ?, parent_id = NULL WHERE id = ?")
        .bind(STAGING_FOLDER_NAME, STAGING_FOLDER_TYPE, existing.id)
        .run();
      return { ...existing, name: STAGING_FOLDER_NAME, type: STAGING_FOLDER_TYPE, parent_id: null };
    }
    return existing;
  }
  const created = await db
    .prepare("INSERT INTO folders (name, type, parent_id, role, created_at) VALUES (?, ?, NULL, ?, ?)")
    .bind(STAGING_FOLDER_NAME, STAGING_FOLDER_TYPE, STAGING_FOLDER_ROLE, timestamp)
    .run();
  return {
    id: Number(created.meta.last_row_id),
    name: STAGING_FOLDER_NAME,
    type: STAGING_FOLDER_TYPE,
    parent_id: null,
    role: STAGING_FOLDER_ROLE,
    created_at: timestamp,
  };
}
