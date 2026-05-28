/**
 * Library entry point.
 *
 * Builds into `dist/bundle.js` as an IIFE assigned to `window.HlsWasmApp`.
 * Demo / DOM wiring lives in `public/demo.js` and consumes this global.
 */
export { HlsWasmPlayer } from "./player.js";
export { HlsController } from "./hls/hls_controller.js";
export {
  parseMediaPlaylist,
  // parseMasterPlaylist,
  classifyPlaylist,
  selectVariantAndAudio,
} from "./hls/playlist_parser.js";
