/* global HlsWasmApp */
/**
 * Demo wiring for the HLS WASM player.
 *
 * The library is loaded from `index.umd.js` which exposes `window.HlsWasmApp`.
 * This file demonstrates:
 *   - All HTMLMediaElement-style APIs:
 *       props : currentTime, duration, muted, volume, playbackRate,
 *               ended, buffered
 *       methods: play(), pause(), load(), plus the lifecycle pair start()/stop()
 *               (and seek() for setting currentTime imperatively)
 *   - All HTMLMediaElement-style events:
 *       loadstart, durationchange, loadedmetadata, playing, waiting,
 *       seeking, seeked, abort, error, ended, ratechange, timeupdate,
 *       volumechange
 */
(function () {
  "use strict";

  if (!window.HlsWasmApp || !HlsWasmApp.HlsWasmPlayer) {
    console.error(
      "[demo] HlsWasmApp.HlsWasmPlayer not found. Did index.umd.js load before demo.js?",
    );
    return;
  }

  const { HlsWasmPlayer } = HlsWasmApp;

  /* ---------- DOM ---------- */
  const canvas = document.getElementById("videoCanvas");
  const urlInput = document.getElementById("urlInput");
  const modeSelect = document.getElementById("modeSelect");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const playBtn = document.getElementById("playBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const loadBtn = document.getElementById("loadBtn");
  const muteToggle = document.getElementById("muteToggle");
  const volumeBar = document.getElementById("volumeBar");
  const volumeLabel = document.getElementById("volumeLabel");
  const rateSelect = document.getElementById("rateSelect");
  const stateLabel = document.getElementById("stateLabel");
  const bufferedLabel = document.getElementById("bufferedLabel");
  const endedLabel = document.getElementById("endedLabel");
  const progressBar = document.getElementById("progressBar");
  const progressLabel = document.getElementById("progressLabel");
  const logBox = document.getElementById("logBox");
  const eventBox = document.getElementById("eventBox");

  let progressDragging = false;

  /* ---------- helpers ---------- */
  function log(msg) {
    const now = new Date().toISOString().slice(11, 19);
    logBox.textContent += `[${now}] ${msg}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function logEvent(name, detail) {
    const now = new Date().toISOString().slice(11, 19);
    const detailStr =
      detail !== undefined && detail !== null
        ? ` ${JSON.stringify(detail, replacer)}`
        : "";
    const line = document.createElement("div");
    line.innerHTML =
      `[${now}] <span class="ev-name">${escapeHtml(name)}</span>` +
      escapeHtml(detailStr);
    eventBox.appendChild(line);
    while (eventBox.childNodes.length > 200) {
      eventBox.removeChild(eventBox.firstChild);
    }
    eventBox.scrollTop = eventBox.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function replacer(_k, v) {
    // Avoid logging huge Error objects verbatim.
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (typeof v === "number" && !Number.isInteger(v)) {
      return Number(v.toFixed(3));
    }
    return v;
  }

  function bufferedAheadSec() {
    const b = player.buffered;
    if (!b || b.length === 0) return 0;
    return Math.max(0, b.end(0) - player.currentTime);
  }

  function refreshStatus(state) {
    if (state) stateLabel.textContent = state;
    bufferedLabel.textContent = `${bufferedAheadSec().toFixed(1)}s`;
    endedLabel.textContent = String(player.ended);
  }

  /* ---------- player ---------- */
  const player = new HlsWasmPlayer({
    canvas,
    wasmJsUrl: "/wasm/decoder.js",
    wasmFileUrl: "/wasm/decoder.wasm",
    log,
  });

  window.player = player; // expose for console debugging

  (async () => {
    try {
      await player.init();
      log("Player initialized.");
      refreshStatus("ready");
    } catch (err) {
      log(`Init failed: ${err.message}`);
    }
  })();

  /* ---------- Event subscriptions (HTMLMediaElement-style) ---------- */

  player.addEventListener("loadstart", (e) => {
    logEvent("loadstart", e.detail);
    refreshStatus("loading");
  });

  player.addEventListener("durationchange", (e) => {
    logEvent("durationchange", { duration: player.duration });
    if (Number.isFinite(player.duration)) {
      progressLabel.textContent = `${fmtTime(player.currentTime)} / ${fmtTime(player.duration)}`;
    }
  });

  player.addEventListener("loadedmetadata", (e) => {
    logEvent("loadedmetadata", e.detail);
  });

  player.addEventListener("playing", () => {
    logEvent("playing");
    refreshStatus("playing");
  });

  player.addEventListener("waiting", () => {
    logEvent("waiting");
    refreshStatus("waiting");
  });

  player.addEventListener("seeking", (e) => {
    logEvent("seeking", e.detail);
    refreshStatus("seeking");
  });

  player.addEventListener("seeked", (e) => {
    logEvent("seeked", e.detail);
  });

  player.addEventListener("abort", () => {
    logEvent("abort");
    refreshStatus("idle");
    progressBar.value = 0;
    progressLabel.textContent = "0:00 / 0:00";
  });

  player.addEventListener("error", (e) => {
    logEvent("error", e.detail);
    refreshStatus("error");
  });

  player.addEventListener("ended", (e) => {
    logEvent("ended", e.detail);
    refreshStatus("ended");
  });

  player.addEventListener("ratechange", (e) => {
    logEvent("ratechange", e.detail);
    rateSelect.value = String(player.playbackRate);
  });

  player.addEventListener("volumechange", (e) => {
    logEvent("volumechange", e.detail);
    volumeBar.value = String(Math.round(player.volume * 100));
    volumeLabel.textContent = `${Math.round(player.volume * 100)}%`;
    muteToggle.checked = player.muted;
  });

  // timeupdate fires ~every 250ms; drive the progress bar from this event.
  player.addEventListener("timeupdate", () => {
    const cur = player.currentTime;
    const dur = player.duration;
    if (!progressDragging && Number.isFinite(dur) && dur > 0) {
      progressBar.value = String(Math.min(100, (cur / dur) * 100));
      progressLabel.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    } else {
      progressLabel.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    }
    refreshStatus();
  });

  /* ---------- Progress bar (currentTime + seek) ---------- */

  progressBar.addEventListener("input", () => {
    const dur = player.duration;
    if (Number.isFinite(dur) && dur > 0) {
      const target = (progressBar.value / 100) * dur;
      progressLabel.textContent = `${fmtTime(target)} / ${fmtTime(dur)}`;
    }
  });

  progressBar.addEventListener("pointerdown", () => {
    progressDragging = true;
  });

  progressBar.addEventListener("pointerup", async () => {
    progressDragging = false;
    const dur = player.duration;
    if (Number.isFinite(dur) && dur > 0) {
      const targetSec = (progressBar.value / 100) * dur;
      try {
        // Two ways to seek: imperative seek(...) or assigning currentTime.
        // Use seek() to get the awaitable promise.
        await player.seek(targetSec);
      } catch (err) {
        log(`Seek failed: ${err.message}`);
      }
    }
  });

  progressBar.addEventListener("pointerleave", () => {
    if (progressDragging) {
      progressDragging = false;
      const dur = player.duration;
      if (Number.isFinite(dur) && dur > 0) {
        const targetSec = (progressBar.value / 100) * dur;
        // Demonstrates the property-setter form too.
        player.currentTime = targetSec;
      }
    }
  });

  /* ---------- Start / Stop / Play / Pause / Load ---------- */

  startBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      log("Please input a valid m3u8 URL.");
      return;
    }
    try {
      await player.start(url, modeSelect.value);
    } catch (err) {
      log(`Start failed: ${err.message}`);
    }
  });

  stopBtn.addEventListener("click", async () => {
    try {
      await player.stop();
    } catch (err) {
      log(`Stop failed: ${err.message}`);
    }
  });

  playBtn.addEventListener("click", async () => {
    try {
      await player.play();
    } catch (err) {
      log(`Play failed: ${err.message}`);
    }
  });

  pauseBtn.addEventListener("click", async () => {
    try {
      await player.pause();
      refreshStatus("paused");
    } catch (err) {
      log(`Pause failed: ${err.message}`);
    }
  });

  loadBtn.addEventListener("click", async () => {
    try {
      await player.load();
    } catch (err) {
      log(`Load failed: ${err.message}`);
    }
  });

  /* ---------- Volume / Mute / Rate ---------- */

  volumeBar.addEventListener("input", () => {
    player.volume = volumeBar.value / 100;
  });

  muteToggle.addEventListener("change", () => {
    player.muted = muteToggle.checked;
  });

  rateSelect.addEventListener("change", () => {
    player.playbackRate = parseFloat(rateSelect.value);
  });
})();
