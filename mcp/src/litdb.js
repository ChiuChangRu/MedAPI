/**
 * LitDB——長儒另一個獨立 repo（chiuchangru/litdb）的文獻／專利知識庫，
 * 用 GitHub Pages 當純靜態網站＋JSON 資料檔（沒有自己的後端）。
 *
 * 這裡不搬資料、不建 D1 表：直接在查詢當下 fetch 那幾個公開的 papers.json，
 * litdb 那邊之後照樣用它自己的方式更新（前端手動編輯 + push），MCP 這邊
 * 永遠讀得到最新版，不需要另外同步。跟 exhibitorsData() 抓 exhibitors.json
 * 是同一個模式，差別只在來源是 GitHub Pages 而不是 Service Binding
 * （litdb 不是同帳號下的 Cloudflare Worker，沒有 Service Binding 可用）。
 */

const COLLECTIONS = {
  coating: {
    url: "https://chiuchangru.github.io/litdb/coating/papers.json",
    label: "親水塗層文獻資料庫",
  },
  biopsy: {
    url: "https://chiuchangru.github.io/litdb/biopsy/biopsy_patents.json",
    label: "活檢針機構知識庫",
  },
  packaging: {
    url: "https://chiuchangru.github.io/litdb/packaging/papers.json",
    label: "醫療器材包裝／捲盤固定技術資料庫",
  },
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, data }

async function fetchCollection(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  const config = COLLECTIONS[key];
  const res = await fetch(config.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** 每個收藏各自獨立讀取，一個壞掉不該讓其他兩個也查不到 */
async function loadAllCollections() {
  const results = await Promise.all(
    Object.keys(COLLECTIONS).map(async (key) => {
      try {
        const data = await fetchCollection(key);
        return { key, ok: true, data };
      } catch (error) {
        return { key, ok: false, error: error.message };
      }
    })
  );
  return results;
}

export function litdbCollectionKeys() {
  return Object.keys(COLLECTIONS);
}

// 測試用：清掉記憶體快取，讓每個測試案例各自控制 fetch 回什麼，不被上一個
// 測試留下的快取影響
export function resetLitdbCacheForTests() {
  cache.clear();
}

/** 列出三個收藏的概況（給 list_litdb_collections 用） */
export async function litdbSummaries() {
  const loaded = await loadAllCollections();
  return loaded.map(({ key, ok, data, error }) => {
    if (!ok) return { key, label: COLLECTIONS[key].label, error };
    return {
      key,
      label: COLLECTIONS[key].label,
      scope: data.meta?.scope || "",
      focus_note: data.meta?.focus_note || "",
      total: (data.papers || []).length,
      stats: data.meta?.stats || null,
      last_updated: data.meta?.last_updated || "",
    };
  });
}

/** 攤平成 [{collection, ...paper}]，跨收藏一起搜尋用；個別收藏讀取失敗時附註哪些查不到 */
export async function litdbAllPapers() {
  const loaded = await loadAllCollections();
  const papers = [];
  const failed = [];
  for (const item of loaded) {
    if (!item.ok) { failed.push({ key: item.key, error: item.error }); continue; }
    for (const paper of item.data.papers || []) papers.push({ collection: item.key, ...paper });
  }
  return { papers, failed };
}

export async function litdbPaper(collectionKey, id) {
  if (!COLLECTIONS[collectionKey]) return null;
  const data = await fetchCollection(collectionKey);
  return (data.papers || []).find((p) => p.id === id) || null;
}

/** search.js 的比對層要吃的「這筆資料的可搜尋文字」 */
export function litdbSearchText(paper) {
  const tags = Array.isArray(paper.tags) ? paper.tags.join(" ") : "";
  const patentSummary = paper.patentResults?.full?.summary || paper.patentResults?.summary || "";
  return [
    paper.title, paper.authors, tags, paper.purpose,
    paper.abstract_note, paper.value_to_project, patentSummary,
  ].filter(Boolean).join("\n");
}
