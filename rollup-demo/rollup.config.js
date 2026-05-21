import { defineConfig } from "rollup";
import serve from "rollup-plugin-serve";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "dist");

/**
 * Custom plugin: copy static assets (index.html, CSS, wasm) to dist/.
 */
function copyAssets() {
  return {
    name: "copy-assets",
    writeBundle() {
      if (!existsSync(dist)) {
        mkdirSync(dist, { recursive: true });
      }

      copyFileSync(
        resolve(__dirname, "index.html"),
        resolve(dist, "index.html"),
      );
      copyFileSync(
        resolve(__dirname, "src", "styles.css"),
        resolve(dist, "styles.css"),
      );

      const wasmDir = resolve(dist, "wasm");
      if (!existsSync(wasmDir)) {
        mkdirSync(wasmDir, { recursive: true });
      }
      copyFileSync(
        resolve(__dirname, "public", "wasm", "decoder.js"),
        resolve(wasmDir, "decoder.js"),
      );
      copyFileSync(
        resolve(__dirname, "public", "wasm", "decoder.wasm"),
        resolve(wasmDir, "decoder.wasm"),
      );
      copyFileSync(
        resolve(__dirname, "src", "wasm", "wasm_worker.js"),
        resolve(wasmDir, "wasm_worker.js"),
      );

      const toneSrc = resolve(__dirname, "public", "tone_440hz_1s.wav");
      if (existsSync(toneSrc)) {
        copyFileSync(toneSrc, resolve(dist, "tone_440hz_1s.wav"));
      }

      console.log("[copy-assets] static assets copied to dist/");
    },
  };
}

export default defineConfig({
  input: "src/main.js",
  output: {
    file: "dist/bundle.js",
    format: "iife",
    name: "HlsWasmApp",
  },
  plugins: [
    copyAssets(),
    process.env.ROLLUP_SERVE !== "false" &&
      serve({
        contentBase: ["dist"],
        host: "localhost",
        port: 3000,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }),
  ].filter(Boolean),
});
