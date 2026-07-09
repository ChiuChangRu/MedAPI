// TODO: 換成負責彙整需求、代為轉達給廠商的窗口信箱
const TEAM_EMAIL = "your-team@example.com";

let EXHIBITORS = [];
let CATEGORIES = [];
let ACTIVE_CATEGORY = "";
let CURRENT_EXHIBITOR = null;

async function init() {
  const res = await fetch("data/exhibitors.json");
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
    <button class="ask" data-id="${e.id}">留言 / 我要洽談</button>
  `;
  card.querySelector("button.ask").onclick = () => openModal(e);
  return card;
}

function openModal(e) {
  CURRENT_EXHIBITOR = e;
  document.getElementById("modal-title").textContent = `聯繫「${e.name_zh}」`;
  document.getElementById("modal-sub").textContent =
    `攤位 ${e.booth_no}｜送出後會開啟您的 Email，草稿已寄給彙整窗口，請直接按送出即可。`;
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

function submitInquiry() {
  const name = document.getElementById("f-name").value.trim();
  const dept = document.getElementById("f-dept").value.trim();
  const contact = document.getElementById("f-contact").value.trim();
  const message = document.getElementById("f-message").value.trim();

  if (!name || !contact || !message) {
    showToast("請填寫姓名、聯絡方式與需求內容");
    return;
  }

  const subject = `[Medtec洽談需求] ${CURRENT_EXHIBITOR.name_zh}（攤位 ${CURRENT_EXHIBITOR.booth_no}）`;
  const body = [
    `廠商：${CURRENT_EXHIBITOR.name_zh}（${CURRENT_EXHIBITOR.booth_no}）`,
    `提出人：${name}`,
    `部門：${dept || "未填"}`,
    `聯絡方式：${contact}`,
    `需求內容：`,
    message,
  ].join("\n");

  const mailto = `mailto:${TEAM_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;

  showToast("已開啟 Email 草稿，請確認後送出");
  closeModal();
}

function showToast(text) {
  const toast = document.getElementById("toast");
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

init();
