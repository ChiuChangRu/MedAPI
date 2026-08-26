const DEFAULT_MYWIKI_URL = "https://fieldlog.gogoyankee.workers.dev";
const url = document.getElementById("url");
const pin = document.getElementById("pin");
const message = document.getElementById("message");

chrome.storage.sync.get({ mywikiUrl: DEFAULT_MYWIKI_URL, pin: "" }).then((config) => {
  url.value = config.mywikiUrl;
  pin.value = config.pin;
});

document.getElementById("save").addEventListener("click", async () => {
  let value;
  try { value = new URL(url.value.trim()); } catch { message.textContent = "網址格式不正確"; message.className = "error"; return; }
  if (value.protocol !== "https:") { message.textContent = "MyWiki 網址必須使用 HTTPS"; message.className = "error"; return; }
  const granted = await chrome.permissions.request({ origins: [`${value.origin}/*`] });
  if (!granted) { message.textContent = "未允許連線到這個 MyWiki 網址"; message.className = "error"; return; }
  await chrome.storage.sync.set({ mywikiUrl: value.href.replace(/\/$/, ""), pin: pin.value.trim() });
  message.textContent = "設定已儲存";
  message.className = "done";
});
