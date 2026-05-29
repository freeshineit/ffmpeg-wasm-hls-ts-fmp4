import { defineConfig } from "rollup";
import typescript from "@rollup/plugin-typescript";
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

      const wasmDir = resolve(dist, "wasm");
      if (!existsSync(wasmDir)) {
        mkdirSync(wasmDir, { recursive: true });
      }
      copyFileSync(resolve(__dirname, "src", "wasm", "wasm_worker.js"), resolve(wasmDir, "wasm_worker.js"));
      // const toneSrc = resolve(__dirname, "public", "tone_440hz_1s.wav");
      // if (existsSync(toneSrc)) {
      //   copyFileSync(toneSrc, resolve(dist, "tone_440hz_1s.wav"));
      // }
      console.log("[copy-assets] static assets copied to dist/");
    },
  };
}

export default defineConfig({
  input: "src/main.ts",
  output: {
    file: "dist/index.umd.js",
    format: "umd",
    name: "HlsWasmApp",
    sourcemap: true,
  },
  plugins: [
    typescript({ tsconfig: "./tsconfig.json" }),
    copyAssets(),
    process.env.ROLLUP_SERVE !== "false" &&
      serve({
        contentBase: ["dist", "public"],
        host: "localhost",
        port: 3000,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }),
  ].filter(Boolean),
});
