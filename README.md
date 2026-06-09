# hls-wasm2

基于 C++ + FFmpeg + WebAssembly 的 HLS 软解播放器，支持 TS/fMP4 封装、WebGL 视频渲染、AudioContext 音频播放，面向直播、回放与 LL-HLS 场景。

## 功能覆盖

- C++ + FFmpeg 编译到 WASM。
- HLS 媒体分片支持：TS、fMP4。
- 视频编码支持：H264/AVC、H265/HEVC。
- 音频编码支持：AAC。
- 视频输出：WebGL（YUV420P 着色显示）。
- 音频输出：AudioContext（Float32 PCM 调度播放）。
- 播放模式：直播、回放；支持 LL-HLS 关键标签（PART、PRELOAD-HINT）。

## 项目结构

- `cpp/`：WASM 解码核心（FFmpeg demux/decode + Emscripten 导出接口）。
- `web/`：浏览器播放器逻辑（HLS 拉取、WASM 调用、WebGL/AudioContext 输出）。

## 一、编译 FFmpeg 到 wasm

前提：
- macOS/Linux
- Emscripten SDK 已安装并 `source emsdk_env.sh`
- 默认使用 FFmpeg 8.1（优先 `cpp/ffmpeg-8.1`，不存在则自动下载到 `cpp/build_ffmpeg/src/ffmpeg-8.1`）

SIMD 相关：
- 默认 `SIMD_MODE=auto`，会自动探测当前 emcc 是否支持 `-msimd128`。
- 可强制指定：`SIMD_MODE=on` 或 `SIMD_MODE=off`。

执行：

```bash
cd cpp
chmod +x build_ffmpeg_wasm.sh
./build_ffmpeg_wasm.sh
```

或通过 make 传递 SIMD 参数：

```bash
cd cpp
make SIMD_MODE=auto ffmpeg
make SIMD_MODE=on ffmpeg
make SIMD_MODE=off ffmpeg
```

编译后输出：`cpp/third_party/ffmpeg-wasm`

## 二、编译播放器 wasm（默认 make，不使用 CMake）

```bash
cd cpp
make
```

可选 SIMD 参数：

```bash
cd cpp
make SIMD_MODE=auto wasm
make SIMD_MODE=on wasm
make SIMD_MODE=off wasm
```

仅重编 wasm（不重编 FFmpeg）：

```bash
cd cpp
make wasm
```

生成文件：
- `cpp/build/decoder.js`
- `cpp/build/decoder.wasm`

说明：`decoder.js` 首行 banner 会标记本次构建的 SIMD 状态（`simd on` 或 `simd off`）。

将它们拷贝到 Web 静态目录：

```bash
mkdir -p rollup-demo/public/wasm
cp cpp/build/decoder.js rollup-demo/public/wasm/
cp cpp/build/decoder.wasm rollup-demo/public/wasm/
```

或使用：

```bash
cd cpp
make install-web
```

## 三、运行 Web 播放器

```bash
cd web
npm install
npm run dev
```

打开浏览器，输入 m3u8 地址后点击“开始播放”。

## 核心实现说明

### 1) WASM 解码核心（`cpp/src/decoder.cpp`）

- 对每个分片创建内存输入流（`AVIOContext`），由 FFmpeg 自动识别 TS/fMP4。
- 自动寻找视频/音频流并打开解码器：
  - 视频：`h264` / `hevc`
  - 音频：`aac`
- 视频统一转 `YUV420P` 后回调 JS。
- 音频统一转换为 `Float32` PCM 后回调 JS。

导出 C 接口：
- `player_create`
- `player_destroy`
- `player_feed_segment`
- `player_reset`

### 2) HLS/LL-HLS 控制（`web/src/hls`）

- 解析媒体播放列表关键标签：
  - `#EXT-X-MAP`
  - `#EXTINF`
  - `#EXT-X-PART`
  - `#EXT-X-PRELOAD-HINT`
  - `#EXT-X-ENDLIST`
- 直播模式循环刷新列表；回放模式在 `ENDLIST` 后停止。
- LL-HLS 场景优先拉取 PART，再拉普通 Segment。

### 3) 视频渲染（`web/src/renderer/webgl_renderer.js`）

- 3 纹理上传 Y/U/V 平面。
- Fragment Shader 里进行 YUV->RGB 转换。

### 4) 音频播放（`web/src/audio/audio_renderer.js`）

- 使用 `AudioContext`。
- 每帧 PCM 写入 `AudioBuffer`，通过 `nextPlayTime` 连续调度，降低抖动。

## 浏览器兼容建议

最低建议：
- Chrome 109+
- Edge 109+
- Safari 16.4+（iOS 也可，但自动播放策略更严格）
- Firefox 113+

兼容点：
- WebAssembly：要求支持 `WASM` 与 `Memory Growth`。
- WebGL：要求支持 WebGL 1.0；不支持时需降级到 Canvas2D（当前版本未实现该降级）。
- AudioContext：
  - 需用户手势触发 `resume()`（已在初始化中处理，但仍建议用户点击后开始播放）。
  - 移动端后台/锁屏会被系统节流。
- CORS：m3u8 与分片必须允许跨域访问。

## 直播与低延迟实践建议

- 使用较小 GOP（例如 1 秒）和较短分片。
- LL-HLS 开启 PART 时，确保服务器正确返回 `#EXT-X-PART` 与 `#EXT-X-PRELOAD-HINT`。
- 若追求极低延迟，需要增加：
  - 基于 PTS 的抖动缓冲策略。
  - 音画同步时钟与动态追帧/丢帧。
  - HTTP/2/3 优化与 CDN 回源策略。

## 当前限制（建议后续迭代）

- 暂未实现 ABR（主播放列表码率切换）。
- 暂未实现 WebGL 不可用时的软件渲染降级。
- 暂未实现 DRM（FairPlay/Widevine/PlayReady）。
- 未包含多音轨/多字幕轨管理。

## 开发建议

- 先用固定码率单清晰度流跑通。
- 再引入 ABR 与更完整的缓冲/同步策略。
- 最后做多端兼容与性能压测（移动端优先）。
