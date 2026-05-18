import { HlsWasmPlayer } from "./player.js";

const canvas = document.getElementById("videoCanvas");
const urlInput = document.getElementById("urlInput");
const modeSelect = document.getElementById("modeSelect");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const logBox = document.getElementById("logBox");

function log(msg) {
  const now = new Date().toISOString().slice(11, 19);
  logBox.textContent += `[${now}] ${msg}\n`;
  logBox.scrollTop = logBox.scrollHeight;
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
