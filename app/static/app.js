let EXHIBITORS = [];
let CATEGORIES = [];
let ACTIVE_CATEGORY = "";
let CURRENT_EXHIBITOR = null;

async function init() {
  const res = await fetch("/api/exhibitors");
  const data = await res.json();
  EXHIBITORS = data.exhibitors;
  CATEGORIES = data.categories;

  document.getElementById("event-title").textContent = data.event.name_zh;
  document.getElementById("event-sub").textContent =
    `${data.event.dates} · ${data.event.venue_zh}`;
  document.getElementById("event-notice").textContent = "⚠️ " + data.event.note;

  buildCategoryChips();
  buildHallFilter();
  render();

  document.getElementById("search").addEventListener("input", render);
  document.getElementById("hall-filter").addEventListener("change", render);
}

function buildCategoryChips() {
  const wrap = document.getElementById("category-chips");
  wrap.innerHTML = "";
  const all = document.createElement("div");
  all.className = "chip active";
  all.textContent = "全部分類";
  all.onclick = () => { ACTIVE_CATEGORY = ""; refreshChips(); render(); };
  wrap.appendChild(all);

  CATEGORIES.forEach((cat) => {
    const count = EXHIBITORS.filter((e) => e.category === cat.id).length;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.dataset.cat = cat.id;
    chip.textContent = `${cat.name_zh} (${count})`;
    chip.onclick = () => { ACTIVE_CATEGORY = cat.id; refreshChips(); render(); };
    wrap.appendChild(chip);
  });
}

function refreshChips() {
  document.querySelectorAll(".chip").forEach((chip) => {
    const isAll = !chip.dataset.cat;
    chip.classList.toggle("active", isAll ? ACTIVE_CATEGORY === "" : chip.dataset.cat === ACTIVE_CATEGORY);
  });
}

function buildHallFilter() {
  const select = document.getElementById("hall-filter");
  const halls = [...new Set(EXHIBITORS.map((e) => e.hall))].sort();
  halls.forEach((h) => {
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = h + " 館";
    select.appendChild(opt);
  });
}

function categoryName(id) {
  const c = CATEGORIES.find((c) => c.id === id);
  return c ? c.name_zh : id;
}

function render() {
  const keyword = document.getElementById("search").value.trim().toLowerCase();
  const hall = document.getElementById("hall-filter").value;

  const filtered = EXHIBITORS.filter((e) => {
    if (ACTIVE_CATEGORY && e.category !== ACTIVE_CATEGORY) return false;
    if (hall && e.hall !== hall) return false;
    if (!keyword) return true;
    const haystack = [
      e.name_zh, e.name_en, e.description, ...(e.tags || []), ...(e.products || [])
    ].join(" ").toLowerCase();
    return haystack.includes(keyword);
  });

  document.getElementById("stats").textContent =
    `共 ${EXHIBITORS.length} 家廠商，符合條件 ${filtered.length} 家`;

  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  document.getElementById("empty").style.display = filtered.length ? "none" : "block";

  filtered.forEach((e) => grid.appendChild(renderCard(e)));
}

function renderCard(e) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="badge-row">
      <span class="badge">${categoryName(e.category)}</span>
      <span class="badge booth">攤位 ${e.booth_no}</span>
    </div>
    <h3>${e.name_zh}</h3>
    <p class="name-en">${e.name_en || ""}</p>
    <p class="desc">${e.description || ""}</p>
    <div class="tags">${(e.tags || []).map((t) => `<span class="tag">#${t}</span>`).join("")}</div>
    <div class="link-row">
      ${e.website ? `<a class="directory-link" href="${e.website}" target="_blank" rel="noopener">🌐 官網</a>` : ""}
      ${(e.pdfs || []).map((p, i) => `<a class="directory-link" href="${p}" target="_blank" rel="noopener">📄 型錄${e.pdfs.length > 1 ? i + 1 : ""}</a>`).join("")}
      ${e.directory_url ? `<a class="directory-link" href="${e.directory_url}" target="_blank" rel="noopener">🔗 展商頁</a>` : ""}
    </div>
    <button class="ask" data-id="${e.id}">留言 / 我要洽談</button>
  `;
  card.querySelector("button.ask").onclick = () => openModal(e);
  return card;
}

function openModal(e) {
  CURRENT_EXHIBITOR = e;
  document.getElementById("modal-title").textContent = `聯繫「${e.name_zh}」`;
  document.getElementById("modal-sub").textContent =
    `攤位 ${e.booth_no}｜您的需求將由專人彙整後，代為轉達給該廠商或安排展中拜訪。`;
  document.getElementById("f-name").value = "";
  document.getElementById("f-dept").value = "";
  document.getElementById("f-contact").value = "";
  document.getElementById("f-message").value = "";
  document.getElementById("overlay").classList.add("open");
}

function closeModal() {
  document.getElementById("overlay").classList.remove("open");
  CURRENT_EXHIBITOR = null;
}

async function submitInquiry() {
  const name = document.getElementById("f-name").value.trim();
  const dept = document.getElementById("f-dept").value.trim();
  const contact = document.getElementById("f-contact").value.trim();
  const message = document.getElementById("f-message").value.trim();

  if (!name || !contact || !message) {
    showToast("請填寫姓名、聯絡方式與需求內容");
    return;
  }

  const res = await fetch("/api/inquiries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      exhibitor_id: CURRENT_EXHIBITOR.id,
      exhibitor_name: CURRENT_EXHIBITOR.name_zh,
      requester_name: name,
      department: dept,
      contact,
      message,
    }),
  });

  if (res.ok) {
    showToast("已送出，感謝您的留言！");
    closeModal();
  } else {
    showToast("送出失敗，請稍後再試");
  }
}

function showToast(text) {
  const toast = document.getElementById("toast");
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

init();
