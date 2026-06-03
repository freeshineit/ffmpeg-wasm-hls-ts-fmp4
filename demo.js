/* global HlsWasmApp */
/**
 * Demo wiring for the HLS WASM player.
 *
 * Interactions:
 *   - All HTMLMediaElement-style APIs & events
 *   - Keyboard: Space (play/pause), M (mute), F (fullscreen), ← → (seek ±5s)
 *   - Canvas click: play/pause toggle
 *   - Canvas dblclick: fullscreen toggle
 *   - Progress bar: hover tooltip, seek on drag
 *   - State-colored status pills
 *   - Loading overlay
 *   - Center play/replay overlay button
 */
(function () {
  "use strict";

  if (!window.HlsWasmApp || !HlsWasmApp.HlsWasmPlayer) {
    console.error("[demo] HlsWasmApp.HlsWasmPlayer not found. Did index.umd.js load before demo.js?");
    return;
  }

  const { HlsWasmPlayer } = HlsWasmApp;

  /* ============ DOM refs ============ */
  const canvas = document.getElementById("videoCanvas");
  const videoContainer = document.getElementById("videoContainer");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const centerPlayBtn = document.getElementById("centerPlayBtn");
  const centerPlayIcon = document.getElementById("centerPlayIcon");
  const centerReplayIcon = document.getElementById("centerReplayIcon");
  const urlInput = document.getElementById("urlInput");
  const modeSelect = document.getElementById("modeSelect");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const playPauseBtn = document.getElementById("playPauseBtn");
  const muteBtn = document.getElementById("muteBtn");
  const volumeBar = document.getElementById("volumeBar");
  const volumeLabel = document.getElementById("volumeLabel");
  const rateSelect = document.getElementById("rateSelect");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const statePill = document.getElementById("statePill");
  const stateLabel = document.getElementById("stateLabel");
  const bufferedLabel = document.getElementById("bufferedLabel");
  const endedLabel = document.getElementById("endedLabel");
  const progressBar = document.getElementById("progressBar");
  const progressLabel = document.getElementById("progressLabel");
  const progressWrapper = document.getElementById("progressWrapper");
  const progressTooltip = document.getElementById("progressTooltip");
  const logBox = document.getElementById("logBox");
  const eventBox = document.getElementById("eventBox");

  let progressDragging = false;

  /* ============ Icons ============ */
  const iconPlayEl = playPauseBtn.querySelector(".icon-play");
  const iconPauseEl = playPauseBtn.querySelector(".icon-pause");
  const iconVolOnEl = muteBtn.querySelector(".icon-vol-on");
  const iconVolOffEl = muteBtn.querySelector(".icon-vol-off");

  function setPlayIcon(playing) {
    if (playing) {
      iconPlayEl.style.display = "none";
      iconPauseEl.style.display = "";
    } else {
      iconPlayEl.style.display = "";
      iconPauseEl.style.display = "none";
    }
  }

  function setVolumeIcon(muted) {
    if (muted) {
      iconVolOnEl.style.display = "none";
      iconVolOffEl.style.display = "";
    } else {
      iconVolOnEl.style.display = "";
      iconVolOffEl.style.display = "none";
    }
  }

  function setCenterPlayIcon(showReplay) {
    centerPlayIcon.style.display = showReplay ? "none" : "";
    centerReplayIcon.style.display = showReplay ? "" : "none";
  }

  /* ============ Helpers ============ */
  function log(msg) {
    const now = new Date().toISOString().slice(11, 19);
    logBox.textContent += `[${now}] ${msg}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60)
      .toString()
      .padStart(2, "0");
    return `${m}:${s}`;
  }

  function logEvent(name, detail) {
    const now = new Date().toISOString().slice(11, 19);
    const detailStr = detail !== undefined && detail !== null ? ` ${JSON.stringify(detail, replacer)}` : "";
    const line = document.createElement("div");
    line.innerHTML = `[${now}] <span class="ev-name">${escapeHtml(name)}</span>` + escapeHtml(detailStr);
    eventBox.appendChild(line);
    while (eventBox.childNodes.length > 200) {
      eventBox.removeChild(eventBox.firstChild);
    }
    eventBox.scrollTop = eventBox.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function replacer(_k, v) {
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

  /**
   * Refresh status pills with color coding by state.
   */
  function refreshStatus(state) {
    if (state) {
      stateLabel.textContent = state;
      // Remove all state classes, then add the current one
      statePill.classList.remove("state-playing", "state-paused", "state-idle", "state-waiting", "state-loading", "state-error", "state-ended");
      const clsMap = {
        playing: "state-playing",
        paused: "state-paused",
        idle: "state-idle",
        ready: "state-idle",
        loading: "state-loading",
        waiting: "state-waiting",
        seeking: "state-waiting",
        error: "state-error",
        ended: "state-ended",
      };
      const cls = clsMap[state] || "";
      if (cls) statePill.classList.add(cls);
    }
    bufferedLabel.textContent = `${bufferedAheadSec().toFixed(1)}s`;
    endedLabel.textContent = String(player.ended);
  }

  /**
   * Show / hide the loading overlay.
   */
  function setLoading(show) {
    loadingOverlay.classList.toggle("active", show);
  }

  /**
   * Show / hide the center play button (paused / idle state).
   */
  function updateCenterPlayBtn() {
    if (player.ended) {
      setCenterPlayIcon(true); // replay icon
      videoContainer.classList.add("idle");
      videoContainer.classList.remove("paused");
    } else if (player.paused && player._lastRenderedFramePtsSec !== null) {
      setCenterPlayIcon(false); // play icon
      videoContainer.classList.add("paused");
      videoContainer.classList.remove("idle");
    } else if (!player.running || !player.hls) {
      setCenterPlayIcon(false);
      videoContainer.classList.add("idle");
      videoContainer.classList.remove("paused");
    } else {
      videoContainer.classList.remove("paused", "idle");
    }
  }

  /* ============ Keyboard shortcuts ============ */
  document.addEventListener("keydown", (e) => {
    // Don't intercept when typing in inputs/selects
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") {
      return;
    }

    switch (e.code) {
      case "Space":
        e.preventDefault();
        if (player.paused) {
          player.play().catch(() => {});
        } else {
          player.pause().catch(() => {});
          refreshStatus("paused");
          updateCenterPlayBtn();
          setPlayIcon(false);
        }
        break;

      case "KeyM":
        player.muted = !player.muted;
        break;

      case "KeyF":
        toggleFullscreen();
        break;

      case "ArrowLeft":
        e.preventDefault();
        seekRelative(-5);
        break;

      case "ArrowRight":
        e.preventDefault();
        seekRelative(5);
        break;
    }
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      videoContainer.requestFullscreen();
    }
  }

  function seekRelative(deltaSec) {
    if (!player.running || !player.hls) return;
    const dur = player.duration;
    if (!Number.isFinite(dur)) return;
    const target = Math.max(0, Math.min(dur, player.currentTime + deltaSec));
    player.seek(target).catch((err) => log(`Seek failed: ${err.message}`));
  }

  /* ============ Canvas click ============ */
  videoContainer.addEventListener("click", (e) => {
    // Don't toggle if clicking the center play button itself (it handles its own click)
    if (e.target.closest("#centerPlayBtn")) return;
    if (player.paused || player.ended) {
      if (player.ended) {
        // Replay
        player
          .seek(0)
          .then(() => player.play())
          .catch(() => {});
      } else {
        player.play().catch(() => {});
      }
    } else {
      player.pause();
      refreshStatus("paused");
      setPlayIcon(false);
      updateCenterPlayBtn();
    }
  });

  videoContainer.addEventListener("dblclick", (e) => {
    // Don't toggle fullscreen if clicking controls
    if (e.target.closest("#centerPlayBtn")) return;
    toggleFullscreen();
  });

  /* Center play button click */
  centerPlayBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (player.ended) {
      player
        .seek(0)
        .then(() => player.play())
        .catch(() => {});
    } else {
      player.play().catch(() => {});
    }
  });

  /* Fullscreen button */
  fullscreenBtn.addEventListener("click", () => toggleFullscreen());

  /* ============ Player ============ */
  const player = new HlsWasmPlayer({
    canvas,
    wasmJsUrl: "/wasm/decoder.js",
    wasmFileUrl: "/wasm/decoder.wasm",
    log,
  });

  window.player = player;

  (async () => {
    try {
      setLoading(true);
      await player.init();
      log("Player initialized.");
      refreshStatus("ready");
    } catch (err) {
      log(`Init failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  })();

  /* ============ Event subscriptions ============ */

  player.addEventListener("loadstart", (e) => {
    logEvent("loadstart", e.detail);
    refreshStatus("loading");
    setLoading(true);
    updateCenterPlayBtn();
  });

  player.addEventListener("durationchange", () => {
    logEvent("durationchange", { duration: player.duration });
    if (Number.isFinite(player.duration)) {
      progressLabel.textContent = `${fmtTime(player.currentTime)} / ${fmtTime(player.duration)}`;
    }
  });

  player.addEventListener("loadedmetadata", (e) => {
    logEvent("loadedmetadata", e.detail);
    setLoading(false);
  });

  player.addEventListener("playing", () => {
    logEvent("playing");
    refreshStatus("playing");
    setLoading(false);
    setPlayIcon(true);
    updateCenterPlayBtn();
  });

  player.addEventListener("waiting", () => {
    logEvent("waiting");
    refreshStatus("waiting");
    setLoading(true);
  });

  player.addEventListener("seeking", (e) => {
    logEvent("seeking", e.detail);
    refreshStatus("seeking");
    setLoading(true);
  });

  player.addEventListener("seeked", (e) => {
    logEvent("seeked", e.detail);
    setLoading(false);
    updateCenterPlayBtn();
  });

  player.addEventListener("abort", () => {
    logEvent("abort");
    refreshStatus("idle");
    progressBar.value = 0;
    progressLabel.textContent = "0:00 / 0:00";
    setLoading(false);
    setPlayIcon(false);
    updateCenterPlayBtn();
  });

  player.addEventListener("error", (e) => {
    logEvent("error", e.detail);
    refreshStatus("error");
    setLoading(false);
  });

  player.addEventListener("ended", (e) => {
    logEvent("ended", e.detail);
    refreshStatus("ended");
    setPlayIcon(false);
    updateCenterPlayBtn();
  });

  player.addEventListener("ratechange", (e) => {
    logEvent("ratechange", e.detail);
    rateSelect.value = String(player.playbackRate);
  });

  player.addEventListener("volumechange", (e) => {
    logEvent("volumechange", e.detail);
    volumeBar.value = String(Math.round(player.volume * 100));
    volumeLabel.textContent = `${Math.round(player.volume * 100)}%`;
    setVolumeIcon(player.muted);
  });

  // timeupdate fires ~every 250ms; drive progress bar + buffered from this
  player.addEventListener("timeupdate", () => {
    const cur = player.currentTime;
    const dur = player.duration;

    if (!progressDragging && Number.isFinite(dur) && dur > 0) {
      progressBar.value = String(Math.min(100, (cur / dur) * 100));
      progressLabel.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;

      // Update buffered range visual (pseudo-element width)
      const bufferedEnd = cur + bufferedAheadSec();
      const bufferedPct = dur > 0 ? Math.min(100, (bufferedEnd / dur) * 100) : 0;
      progressWrapper.style.setProperty("--buffered-pct", `${bufferedPct}%`);
    } else {
      progressLabel.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    }

    refreshStatus();
  });

  /* ============ Progress bar ============ */

  // Set the buffered track width via CSS custom property
  progressBar.style.setProperty("--val", "0%");
  // The buffered ::after pseudo-element uses this:
  progressWrapper.style.setProperty("--buffered-pct", "0%");

  // Inject a style rule for the dynamic buffered width
  const bufferedStyle = document.createElement("style");
  bufferedStyle.textContent = `
    .progress-bar-wrapper::after {
      width: var(--buffered-pct, 0%);
    }
  `;
  document.head.appendChild(bufferedStyle);

  // Also need to make the progress bar fill track reflect the slider value.
  // We use a CSS custom property driven by the input event.
  const progressFillStyle = document.createElement("style");
  progressFillStyle.textContent = `
    .progress-bar::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 3px;
      background: transparent;
    }
    .progress-bar::-moz-range-track {
      height: 6px;
      border-radius: 3px;
      background: transparent;
    }
    .progress-bar-wrapper {
      --played-pct: 0%;
    }
    /* Use a gradient on the ::before to show played portion.
       Replace the flat ::before with a two-stop gradient. */
    .progress-bar-wrapper::before {
      background: linear-gradient(to right,
        var(--action-2) 0%,
        var(--action-2) var(--played-pct, 0%),
        rgba(49, 89, 123, 0.4) var(--played-pct, 0%),
        rgba(49, 89, 123, 0.4) 100%
      ) !important;
    }
  `;
  document.head.appendChild(progressFillStyle);

  progressBar.addEventListener("input", () => {
    const dur = player.duration;
    const pct = Number(progressBar.value);
    progressWrapper.style.setProperty("--played-pct", `${pct}%`);

    if (Number.isFinite(dur) && dur > 0) {
      const target = (pct / 100) * dur;
      progressLabel.textContent = `${fmtTime(target)} / ${fmtTime(dur)}`;
    }
  });

  // Hover tooltip on progress bar wrapper
  progressWrapper.addEventListener("mousemove", (e) => {
    const dur = player.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const rect = progressWrapper.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * dur;
    progressTooltip.textContent = fmtTime(time);
    progressTooltip.style.left = `${pct * 100}%`;
  });

  progressWrapper.addEventListener("mouseleave", () => {
    progressTooltip.textContent = "";
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
        player.currentTime = targetSec;
      }
    }
  });

  /* ============ Buttons ============ */

  startBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      log("Please input a valid m3u8 URL.");
      return;
    }
    try {
      setLoading(true);
      await player.start(url, modeSelect.value);
    } catch (err) {
      log(`Start failed: ${err.message}`);
      setLoading(false);
    }
  });

  stopBtn.addEventListener("click", async () => {
    try {
      await player.stop();
    } catch (err) {
      log(`Stop failed: ${err.message}`);
    }
  });

  playPauseBtn.addEventListener("click", async () => {
    try {
      if (player.paused || player.ended) {
        if (player.ended) {
          await player.seek(0);
        }
        await player.play();
      } else {
        await player.pause();
        refreshStatus("paused");
        setPlayIcon(false);
        updateCenterPlayBtn();
      }
    } catch (err) {
      log(`Play/Pause failed: ${err.message}`);
    }
  });

  muteBtn.addEventListener("click", () => {
    player.muted = !player.muted;
  });

  /* ============ Volume / Rate ============ */

  volumeBar.addEventListener("input", () => {
    player.volume = volumeBar.value / 100;
  });

  rateSelect.addEventListener("change", () => {
    player.playbackRate = parseFloat(rateSelect.value);
  });
})();
