;(() => {
  if (window.__fieldlogSimpleHome) return;
  window.__fieldlogSimpleHome = true;

  // 錄影／錄音中的「記一句」改用後端原子 append；首頁 quickNote() 不受影響。
  window.addTimedNote = async function atomicTimedNote(session) {
    if (!session) return;
    const text = prompt("記一句（會標上目前的時間點）：");
    if (!text || !text.trim()) return;
    const offset = fmtSecs(segOffset(session));
    const line = `[${offset}] ${text.trim()}`;
    try {
      await api(`/entries/${session.entryId}/notes`, {
        method: "POST",
        body: JSON.stringify({ line }),
      });
      showToast("已記錄");
    } catch (error) {
      showToast("記錄失敗：" + error.message);
    }
  };

  function removeDeferredHomepageExtras() {
    document.querySelectorAll(".folder-architecture-guide, .home-knowledge-card").forEach((element) => element.remove());
  }

  function hasActualUsage(item) {
    if (!item) return false;
    if (item.key === "ai") {
      return Number(item.used || 0) > 0 || Number(item.monthlyPaidCost || 0) > 0;
    }
    return Number(item.used || 0) > 0;
  }

  async function loadActiveUsageOnly() {
    const wrap = document.getElementById("usage-content");
    if (!wrap) return;
    wrap.innerHTML = '<p class="usage-quiet">正在讀取…</p>';

    try {
      const data = await api("/usage");
      const activeLimits = (data.limits || []).filter(hasActualUsage);
      const totalCost = Number(data.totalCost || 0);

      if (!activeLimits.length && totalCost <= 0) {
        wrap.innerHTML = '<p class="usage-quiet">目前沒有可顯示的用量。</p>';
        return;
      }

      const costHtml = totalCost > 0
        ? '<div class="usage-total"><span>本期費用</span><strong>' + esc(data.currency || "USD") + ' ' + fmtUsageNumber(totalCost) + '</strong></div>'
        : '';
      const limitsHtml = activeLimits.length
        ? '<div class="usage-limits active-usage-list">' + activeLimits.map(renderUsageLimit).join("") + '</div>'
        : '';
      const updatedHtml = data.updatedAt
        ? '<p class="sub usage-updated">更新：' + new Date(data.updatedAt).toLocaleString("zh-TW") + '</p>'
        : '';

      wrap.innerHTML = costHtml + limitsHtml + updatedHtml;
    } catch (error) {
      wrap.innerHTML = '<p class="usage-error">暫時無法讀取用量：' + esc(error.message) + '</p>';
    }
  }

  loadUsage = loadActiveUsageOnly;
  const refreshButton = document.getElementById("btn-usage-refresh");
  if (refreshButton) refreshButton.onclick = loadActiveUsageOnly;

  removeDeferredHomepageExtras();
  new MutationObserver(removeDeferredHomepageExtras).observe(document.documentElement, { childList: true, subtree: true });
  loadActiveUsageOnly();
})();
