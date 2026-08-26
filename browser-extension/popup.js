const statusEl = document.getElementById("status");
const bar = document.getElementById("bar");
const save = document.getElementById("save");

function progress(text, percent, state = "") {
  statusEl.textContent = text;
  statusEl.className = state;
  bar.style.width = `${percent}%`;
  bar.parentElement.setAttribute("aria-valuenow", String(percent));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "clip-progress") progress(message.text, message.percent, message.phase === "done" ? "done" : "");
});

save.addEventListener("click", async () => {
  save.disabled = true;
  progress("準備剪藏…", 5);
  const response = await chrome.runtime.sendMessage({ type: "save-clip" }).catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    progress(response?.error || "剪藏失敗", 0, "error");
    save.disabled = false;
    save.textContent = "重新嘗試";
  }
});

document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
