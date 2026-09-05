// MyWiki 錄音 runtime hardening（v171）。
//
// 這個檔案在部署時會接到 app.js 最後。它只修正目前錄音的幾個高風險點：
// 1. 不再覆寫 app.js 內建的 onPageHidden；iPhone/iPad 切背景必須依 app.js 正常收尾，
//    不能再被舊 hotfix 改成「背景繼續假錄」。
// 2. 恢復收音時，量到 peak=0 的候選麥克風不算成功，避免每幾秒重建一個空段。
// 3. 已確認整段都是數位零的音訊不進附件、不送轉錄。
// 4. 技術診斷留在 console，記事只留下精簡且去重的使用者可讀警示。
(() => {
  try {
    const ORIGINAL = {
      noteAudioInterruption,
      acquireLiveMic,
      noteMicPeak,
      startAudioSegRecorder,
      onAudioSegmentStop,
      attemptMicSwap,
      resumeAudioOnForeground,
    };

    const warningKeys = new Map();

    function warningSet(entryId) {
      const key = Number(entryId || 0);
      if (!warningKeys.has(key)) warningKeys.set(key, new Set());
      return warningKeys.get(key);
    }

    async function saveWarningOnce(entryId, key, line) {
      const seen = warningSet(entryId);
      if (seen.has(key)) return;
      seen.add(key);
      await ORIGINAL.noteAudioInterruption(entryId, line);
    }

    // 正式記事不再塞滿 peak、bytes/秒、裝置輪詢等工程診斷。
    noteAudioInterruption = async function noteAudioInterruptionCompact(entryId, line) {
      const text = String(line || "").trim();
      if (!text) return;

      if (/^🔬\s*診斷/.test(text)) {
        console.warn("[MyWiki 錄音診斷]", text);
        return;
      }

      if (/未產生錄音檔（0 bytes）|未產生有效音訊|數位零/.test(text)) {
        console.warn("[MyWiki 錄音無效段]", text);
        return saveWarningOnce(
          entryId,
          "invalid-audio-segment",
          "⚠️ 本次錄音有分段未產生有效音訊；無效分段已忽略，不會列入播放或轉錄。"
        );
      }

      if (/偵測到麥克風無訊號|麥克風沒有有效訊號|每個收音裝置都試過/.test(text)) {
        console.warn("[MyWiki 麥克風無訊號]", text);
        return saveWarningOnce(
          entryId,
          "mic-no-signal",
          "⚠️ 本次錄音曾偵測到麥克風無訊號；系統已暫停建立空音檔，偵測到聲音後才會接續。"
        );
      }

      if (/錄音器在約 .*曾被系統中止|App／分頁切到背景/.test(text)) {
        console.warn("[MyWiki 背景中斷]", text);
        return saveWarningOnce(
          entryId,
          "background-interruption",
          "⚠️ 本次錄音曾因 App／分頁進入背景而中斷；可用音訊已保留，回到前景後會重新檢查收音。"
        );
      }

      return ORIGINAL.noteAudioInterruption(entryId, text);
    };

    // startAudio() 在 AUDIO 尚未建立前仍允許回傳 silent=true，讓既有確認框阻擋開錄。
    // 錄音進行中的恢復流程則不同：peak=0 絕不能被當成「換源成功」。
    acquireLiveMic = async function acquireLiveMicRequireSignal(avoidDeviceId, options = {}) {
      const picked = await ORIGINAL.acquireLiveMic(avoidDeviceId, options);
      if (AUDIO && !AUDIO.ending && picked?.silent) {
        stopStream(picked.stream);
        const error = new Error("所有收音裝置目前都沒有有效訊號");
        error.name = "NoLiveMicSignalError";
        throw error;
      }
      return picked;
    };

    // 每一個 recorder 自己記錄「這一段」實際量到的最大 peak。
    // 不能再用整場錄音的 diagPeakMax 判定單一段，否則前面曾有聲音會掩蓋後面空段。
    startAudioSegRecorder = function startAudioSegRecorderWithSignalLedger() {
      const recorder = ORIGINAL.startAudioSegRecorder();
      if (recorder) {
        recorder.__mywikiPeakMax = 0;
        recorder.__mywikiPeakSamples = 0;
      }
      return recorder;
    };

    function scheduleResumeFromSignal(session) {
      if (!session || session.__resumeScheduled) return;
      session.__resumeScheduled = true;
      setTimeout(() => {
        if (AUDIO !== session) return;
        session.__resumeScheduled = false;
        if (
          session.ending ||
          !session.__signalSuspended ||
          document.hidden ||
          session.deadSince
        ) return;

        if (session.recorder?.state === "recording") {
          session.__signalSuspended = false;
          session.resuming = false;
          return;
        }

        session.__signalSuspended = false;
        session.resuming = false;
        session.segIndex++;
        startAudioSegRecorder();
        setAudioStatus("✓ 麥克風訊號已恢復，錄音已接續", false);
      }, 80);
    }

    noteMicPeak = function noteMicPeakWithSegmentLedger(peak) {
      const session = AUDIO;
      const recorder = session?.recorder;
      if (recorder && peak !== null && Number.isFinite(peak)) {
        recorder.__mywikiPeakSamples = (recorder.__mywikiPeakSamples || 0) + 1;
        recorder.__mywikiPeakMax = Math.max(recorder.__mywikiPeakMax || 0, peak);
      }

      const result = ORIGINAL.noteMicPeak(peak);

      if (
        session &&
        AUDIO === session &&
        session.__signalSuspended &&
        peak !== null &&
        peak > AUDIO_SIGNAL_FLOOR &&
        !document.hidden
      ) {
        scheduleResumeFromSignal(session);
      }
      return result;
    };

    function segmentBlob(recorder, chunks) {
      return new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    }

    function segmentHasNoSignal(recorder) {
      const samples = Number(recorder?.__mywikiPeakSamples || 0);
      const peakMax = Number(recorder?.__mywikiPeakMax || 0);
      return samples >= 2 && peakMax <= AUDIO_SIGNAL_FLOOR;
    }

    async function finishDiscardedSegment(recorder, seg, reason) {
      const session = AUDIO;
      if (session) session.emptySegments = (session.emptySegments || 0) + 1;

      await noteAudioInterruption(
        seg.entryId,
        `⛔ 第 ${seg.index} 段未產生有效音訊（${reason}），已忽略，不播放也不轉錄。`
      );

      if (!session || AUDIO !== session) return;
      const isCurrent = session.recorder === recorder;

      if (session.ending && isCurrent) {
        finalizeAudioStop();
        return;
      }

      // 一般輪替只有「目前 recorder」才需要接下一段。
      // 若是因無訊號主動暫停，resuming/__signalSuspended 會阻止立刻再造一個空段。
      if (
        isCurrent &&
        !session.ending &&
        !document.hidden &&
        !session.resuming &&
        !session.__signalSuspended
      ) {
        session.segIndex++;
        startAudioSegRecorder();
      }
    }

    onAudioSegmentStop = async function onAudioSegmentStopRejectInvalid(recorder, chunks, seg) {
      const blob = segmentBlob(recorder, chunks);
      const durationSecs = Math.max(1, Math.ceil((Date.now() - seg.startedAt) / 1000));
      const noSignal = segmentHasNoSignal(recorder);

      // 0 bytes、只有容器表頭的極小檔、或整段實測皆為數位零，都不是可用錄音。
      // 「整段數位零」只有在 analyser 至少實際採到兩次樣本才成立；無 analyser 的
      // 瀏覽器不會因為沒量測資料而被誤刪。
      if (!blob.size) {
        return finishDiscardedSegment(recorder, seg, "0 bytes");
      }
      if (durationSecs >= 2 && blob.size < 512) {
        return finishDiscardedSegment(recorder, seg, `${blob.size} bytes`);
      }
      if (noSignal) {
        return finishDiscardedSegment(recorder, seg, "全段 peak=0");
      }

      return ORIGINAL.onAudioSegmentStop(recorder, chunks, seg);
    };

    async function suspendRecorderUntilSignal(session) {
      if (
        !session ||
        AUDIO !== session ||
        session.ending ||
        session.__signalSuspended ||
        document.hidden ||
        session.recorder?.state !== "recording"
      ) return;

      session.__signalSuspended = true;
      // 既有 onstop 看到 resuming=true 就不會自動再開下一段。
      session.resuming = true;
      session.interrupted = true;

      try { session.recorder.requestData(); } catch {}
      try { session.recorder.stop(); } catch {}

      setAudioStatus(
        "⚠️ 麥克風沒有有效訊號，已暫停建立音檔；偵測到聲音後會自動接續",
        true
      );
      await noteAudioInterruption(
        session.entryId,
        "⚠️ 麥克風沒有有效訊號；已暫停建立空音檔，等待有效聲音恢復。"
      );
    }

    // 原本的 attemptMicSwap 在所有候選都 peak=0 時仍會把 silent fallback 當成新來源，
    // 造成「換源 → 新空段 → 再換源」循環。現在 silent 候選已被 acquireLiveMic
    // 拒絕；若一次恢復嘗試後仍持續無訊號，就停掉 recorder，但保留麥克風監測。
    attemptMicSwap = async function attemptMicSwapWithoutEmptySegments() {
      const session = AUDIO;
      if (!session || session.ending) return;

      const beforeSwapAt = session.lastSwapAt;
      await ORIGINAL.attemptMicSwap();

      if (!AUDIO || AUDIO !== session || session.ending) return;

      // 成功換到真正有訊號的來源時，原函式會清 deadSince 並開新 recorder。
      if (!session.deadSince && session.recorder?.state === "recording") {
        session.__signalSuspended = false;
        session.resuming = false;
        return;
      }

      const didTryRecovery = session.lastSwapAt !== beforeSwapAt;
      const stillDead =
        session.deadSince &&
        Date.now() - session.deadSince >= AUDIO_DEAD_SIGNAL_MS;

      if (didTryRecovery && stillDead) {
        await suspendRecorderUntilSignal(session);
      }
    };

    // visibilitychange 使用動態函式名稱，會走到這個 wrapper。
    // 若目前因「無有效訊號」而暫停，回前景只重新檢查，不可先盲開一個 recorder。
    resumeAudioOnForeground = async function resumeAudioOnForegroundSignalAware(...args) {
      if (AUDIO?.__signalSuspended && !AUDIO.ending) {
        if (AUDIO.audioCtx && AUDIO.audioCtx.state !== "running") {
          AUDIO.audioCtx.resume().catch(() => {});
        }
        checkMicSignal();
        return;
      }
      return ORIGINAL.resumeAudioOnForeground(...args);
    };

    // pageshow/resume 的舊 listener 在 init() 時已綁定舊函式物件，無法靠重新賦值替換。
    // 追加一道修正：如果舊 listener 先盲開了空 recorder，立刻再停掉，該短段會被上面
    // 的 onAudioSegmentStop 判定為無效而丟棄。
    function enforceSignalSuspension() {
      const session = AUDIO;
      if (!session?.__signalSuspended || session.ending || session.deadSince === 0) return;
      if (session.recorder?.state === "recording") {
        try { session.recorder.requestData(); } catch {}
        try { session.recorder.stop(); } catch {}
        session.resuming = true;
      }
    }
    window.addEventListener("pageshow", () => setTimeout(enforceSignalSuspension, 0));
    document.addEventListener("resume", () => setTimeout(enforceSignalSuspension, 0));

    // 刻意不改 onPageHidden。app.js v170 已經有正確規則：
    // iOS 切背景立即正常收尾；非 iOS 才做 best-effort。
    console.info("MyWiki recording runtime hardening v171 active");
  } catch (err) {
    console.error("MyWiki recording runtime hardening failed", err);
  }
})();
