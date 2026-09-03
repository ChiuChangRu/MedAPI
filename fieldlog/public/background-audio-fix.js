// MyWiki iOS background audio runtime patch.
// Loaded by deployment concatenation AFTER app.js init(), so it replaces the old v167
// onPageHidden implementation instead of being overwritten by app.js during startup.
// Keep this patch until the same logic is folded directly into app.js.
(() => {
  try {
    onPageHidden = function onPageHiddenBestEffortAudio() {
      if (VIDEO) { VIDEO.autoStopped = true; stopVideo(); }
      if (AUDIO && !AUDIO.ending) {
        AUDIO.backgroundAt ||= Date.now();
        setAudioStatus("🎙️ 背景錄音嘗試中；回前景會自動檢查並接續");
        try {
          if (AUDIO.recorder?.state === "recording") AUDIO.recorder.requestData();
        } catch {}
      }
      if (AUDIO_PHOTO_STREAM) {
        clearTimeout(AUDIO_PHOTO_HIDE_TIMER);
        AUDIO_PHOTO_HIDE_TIMER = setTimeout(() => {
          if (document.hidden && AUDIO_PHOTO_STREAM) closeAudioPhotoPopup();
        }, 1500);
      }
    };
    console.info("MyWiki background-audio best-effort patch active");
  } catch (err) {
    console.error("MyWiki background-audio patch failed", err);
  }
})();
