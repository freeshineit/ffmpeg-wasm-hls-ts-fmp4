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
        resolve(__dirname, "public", "wasm", "player_wasm.js"),
        resolve(wasmDir, "player_wasm.js"),
      );
      copyFileSync(
        resolve(__dirname, "public", "wasm", "player_wasm.wasm"),
        resolve(wasmDir, "player_wasm.wasm"),
      );

      const silenceSrc = resolve(__dirname, "public", "silence.wav");
      if (existsSync(silenceSrc)) {
        copyFileSync(silenceSrc, resolve(dist, "silence.wav"));
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
