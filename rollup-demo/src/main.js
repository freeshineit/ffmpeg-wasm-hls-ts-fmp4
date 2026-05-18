import { HlsWasmPlayer } from "./player.js";

const canvas = document.getElementById("videoCanvas");
const urlInput = document.getElementById("urlInput");
const modeSelect = document.getElementById("modeSelect");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const logBox = document.getElementById("logBox");

// Progress bar
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
let progressDragging = false;
let progressRafId = 0;

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

const player = new HlsWasmPlayer({
  canvas,
  wasmJsUrl: "/wasm/decoder.js",
  wasmFileUrl: "/wasm/decoder.wasm",
  log,
});

(async () => {
  try {
    await player.init();
    log("Player initialized.");
  } catch (err) {
    log(`Init failed: ${err.message}`);
  }
})();

/* ---- Progress bar update loop ---- */

function startProgressLoop() {
  if (progressRafId) return;

  const tick = () => {
    const total = player.getTotalDuration();
    const current = player.getCurrentTime();

    if (!progressDragging && total > 0) {
      const pct = Math.min(100, (current / total) * 100);
      progressBar.value = pct;
      progressLabel.textContent = `${fmtTime(current)} / ${fmtTime(total)}`;
    }

    progressRafId = requestAnimationFrame(tick);
  };
  progressRafId = requestAnimationFrame(tick);
}

function stopProgressLoop() {
  if (progressRafId) {
    cancelAnimationFrame(progressRafId);
    progressRafId = 0;
  }
  progressBar.value = 0;
  progressLabel.textContent = "0:00 / 0:00";
}

/* ---- Seek via progress bar ---- */

progressBar.addEventListener("input", () => {
  // Update label while dragging
  const total = player.getTotalDuration();
  if (total > 0) {
    const target = (progressBar.value / 100) * total;
    progressLabel.textContent = `${fmtTime(target)} / ${fmtTime(total)}`;
  }
});

progressBar.addEventListener("pointerdown", () => {
  progressDragging = true;
});

progressBar.addEventListener("pointerup", async () => {
  progressDragging = false;
  const total = player.getTotalDuration();
  if (total > 0) {
    const targetSec = (progressBar.value / 100) * total;
    try {
      await player.seek(targetSec);
    } catch (err) {
      log(`Seek failed: ${err.message}`);
    }
  }
});

// Also handle touch/mouse leave
progressBar.addEventListener("pointerleave", () => {
  if (progressDragging) {
    progressDragging = false;
    const total = player.getTotalDuration();
    if (total > 0) {
      const targetSec = (progressBar.value / 100) * total;
      player.seek(targetSec).catch((err) => log(`Seek failed: ${err.message}`));
    }
  }
});

/* ---- Start / Stop ---- */

startBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    log("Please input a valid m3u8 URL.");
    return;
  }

  try {
    await player.start(url, modeSelect.value);
    startProgressLoop();
  } catch (err) {
    log(`Start failed: ${err.message}`);
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await player.stop();
    stopProgressLoop();
  } catch (err) {
    log(`Stop failed: ${err.message}`);
  }
});
