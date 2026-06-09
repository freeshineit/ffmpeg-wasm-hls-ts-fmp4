# hls-wasm2 — C++ WebAssembly 解码器

基于 FFmpeg + Emscripten 的 HLS 解码器，将 C++ 编译为 WebAssembly，在浏览器中完成音视频解码。本文档同时覆盖构建和“编译后的 wasm 怎么接入、怎么喂流、回调返回什么、有哪些限制”。

## 项目结构

```
cpp/
├── src/
│   └── decoder.cpp          # 解码器核心实现
├── include/
│   └── decoder.h            # 对外 C API 声明
├── build/                   # 构建产物（decoder.js / decoder.wasm）
├── third_party/
│   └── ffmpeg-wasm/         # FFmpeg WASM 静态库
├── Makefile                 # 构建配置
├── build_ffmpeg_wasm.sh     # FFmpeg 交叉编译脚本
├── Dockerfile               # Docker 镜像定义
├── docker-compose.yml       # Docker Compose 编排
├── docker-build.sh          # Docker 一键构建脚本
└── .dockerignore            # Docker 忽略文件
```

## 快速结论

编译完成后你会得到两个文件：

| 文件 | 说明 |
|------|------|
| `build/decoder.js` | Emscripten 生成的 JS 胶水代码，导出默认工厂函数 `HlsPlayerModule` |
| `build/decoder.wasm` | WebAssembly 二进制文件 |

在浏览器里，正确使用方式是：

1. 通过 `import` 或脚本标签加载 `decoder.js`。
2. 调用 `HlsPlayerModule({ locateFile })` 初始化 wasm 模块。
3. 通过模块对象上的 `_player_create / _player_feed_segment / _player_reset / _player_destroy` 操作解码器。
4. 通过 `Module.onVideoFrame / Module.onAudioFrame / Module.onLog` 接收解码输出。
5. 喂入二进制分片前，先把 JS 的 `Uint8Array` 拷贝进 wasm 堆内存。

## 构建方式

当前构建脚本支持按环境自动开启 SIMD。

- `SIMD_MODE=auto`（默认）：自动探测 emcc 是否支持 `-msimd128`。
- `SIMD_MODE=on`：强制开启 SIMD。
- `SIMD_MODE=off`：强制关闭 SIMD。
- `HLS_WASM_SIMD`（0/1）优先级高于 `SIMD_MODE`，主要由 Makefile 在内部传递预计算结果。

### 方式一：Docker 构建

无需安装 Emscripten SDK，只依赖 Docker。

```bash
# 完整构建（FFmpeg + decoder wasm）
./docker-build.sh

# 或
make docker-build
```

分步构建：

```bash
# 首次构建 FFmpeg（通常最慢）
./docker-build.sh ffmpeg

# 构建 wasm 胶水和二进制
./docker-build.sh wasm

# 复制到 web 项目
./docker-build.sh install-web
```

其他命令：

```bash
./docker-build.sh shell
./docker-build.sh clean
```

使用 Docker Compose：

```bash
docker compose run --rm build
docker compose run --rm build-ffmpeg
docker compose run --rm build-wasm
docker compose run --rm shell
```

### 方式二：本地构建

需要预先安装 [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)。

```bash
source /path/to/emsdk/emsdk_env.sh

make all
make ffmpeg
make wasm
make clean
```

带 SIMD 参数的示例：

```bash
make SIMD_MODE=auto all
make SIMD_MODE=on ffmpeg wasm
make SIMD_MODE=off wasm
```

如果需要直接调用脚本：

```bash
SIMD_MODE=auto ./build_ffmpeg_wasm.sh
SIMD_MODE=on ./build_ffmpeg_wasm.sh
SIMD_MODE=off ./build_ffmpeg_wasm.sh
```

## 编译产物的运行特性

当前编译参数的重要点如下：

- 产物是 `-sMODULARIZE=1`，因此 `decoder.js` 导出的是一个异步工厂函数，不是立即可用的全局实例。
- 导出名称是 `HlsPlayerModule`。
- 运行环境限定为 `web`。
- 根据环境与 `SIMD_MODE`，会自动决定是否附加 `-msimd128`。
- 仅导出了 `_malloc`、`_free`、`_player_create`、`_player_destroy`、`_player_feed_segment`、`_player_reset`、`_player_get_current_time`。
- 仅导出了运行时方法 `HEAPU8`，没有导出 `ccall`、`cwrap`、`HEAPF32`。
- wasm 文件路径依赖 `locateFile('decoder.wasm')` 解析，因此部署时通常需要显式提供 `locateFile`。

这意味着你应当直接调用底层导出函数，而不是依赖 `ccall/cwrap`。

## 对外 JS 接口说明

### 1. 初始化模块

ESM 示例：

```js
import HlsPlayerModule from './decoder.js';

const Module = await HlsPlayerModule({
	locateFile(path) {
		if (path === 'decoder.wasm') {
			return '/wasm/decoder.wasm';
		}
		return path;
	},
	onLog(level, message) {
		console.log('[decoder]', level, message);
	},
	onVideoFrame(width, height, yPtr, yStride, uPtr, uStride, vPtr, vStride, ptsMs, isKeyFrame, codecName) {
		console.log('video frame', { width, height, ptsMs, isKeyFrame, codecName });
	},
	onAudioFrame(channels, sampleRate, sampleCount, dataPtr, ptsMs, codecName) {
		console.log('audio frame', { channels, sampleRate, sampleCount, ptsMs, codecName });
	}
});
```

如果是通过 `<script>` 使用，`decoder.js` 会暴露 `HlsPlayerModule` 工厂函数；调用方式保持一致。

### 2. 创建和销毁播放器实例

```js
const handle = Module._player_create();

Module._player_reset(handle);
Module._player_destroy(handle);
```

一个 `handle` 对应一个解码器实例。通常一条播放链路使用一个实例；切流、seek、源重置时调用 `_player_reset`，完全销毁时调用 `_player_destroy`。

### 3. 喂入二进制分片

`_player_feed_segment(handle, ptr, size, isInitSegment)` 的 `ptr` 必须指向 wasm 堆上的一段内存，因此不能把 JS 的 `Uint8Array` 直接传进去，必须先拷贝。

```js
function feedSegment(Module, handle, bytes, isInitSegment) {
	const ptr = Module._malloc(bytes.byteLength);
	try {
		Module.HEAPU8.set(bytes, ptr);
		return Module._player_feed_segment(handle, ptr, bytes.byteLength, isInitSegment ? 1 : 0);
	} finally {
		Module._free(ptr);
	}
}
```

推荐喂入时序：

1. 如果是 fMP4 HLS，先把 `EXT-X-MAP` 对应的 init segment 用 `isInitSegment = 1` 喂入一次。
2. 后续每个媒体分片或 part 用 `isInitSegment = 0` 喂入。
3. 切流、seek 或明显时间轴重建时，先调用 `_player_reset(handle)`，然后重新喂 init segment，再喂媒体分片。

### 4. 获取当前时间

```js
const currentTimeMs = Module._player_get_current_time(handle);
```

返回值单位是毫秒。

- 有视频时，通常跟随最近输出的视频帧 PTS。
- 仅音频时，跟随最近输出的音频帧 PTS。

## 完整浏览器接入示例

下面的示例演示了如何加载模块、创建实例、喂 init segment 和媒体 segment，并把输出帧交给上层渲染器或播放器。

```js
import HlsPlayerModule from './decoder.js';

export async function createDecoder(options = {}) {
	const Module = await HlsPlayerModule({
		locateFile(path) {
			if (path === 'decoder.wasm') {
				return options.wasmURL ?? '/wasm/decoder.wasm';
			}
			return path;
		},
		onLog(level, message) {
			options.onLog?.(level, message);
		},
		onVideoFrame(width, height, yPtr, yStride, uPtr, uStride, vPtr, vStride, ptsMs, isKeyFrame, codecName) {
			const heap = Module.HEAPU8;
			const ySize = yStride * height;
			const uvHeight = Math.ceil(height / 2);
			const uSize = uStride * uvHeight;
			const vSize = vStride * uvHeight;

			options.onVideoFrame?.({
				width,
				height,
				ptsMs,
				isKeyFrame: Boolean(isKeyFrame),
				codecName,
				y: heap.slice(yPtr, yPtr + ySize),
				u: heap.slice(uPtr, uPtr + uSize),
				v: heap.slice(vPtr, vPtr + vSize),
				yStride,
				uStride,
				vStride
			});
		},
		onAudioFrame(channels, sampleRate, sampleCount, dataPtr, ptsMs, codecName) {
			const sampleView = new Float32Array(Module.HEAPU8.buffer, dataPtr, sampleCount * channels);

			options.onAudioFrame?.({
				channels,
				sampleRate,
				sampleCount,
				ptsMs,
				codecName,
				pcm: new Float32Array(sampleView)
			});
		}
	});

	const handle = Module._player_create();

	function feed(bytes, { isInitSegment = false } = {}) {
		const ptr = Module._malloc(bytes.byteLength);
		try {
			Module.HEAPU8.set(bytes, ptr);
			return Module._player_feed_segment(handle, ptr, bytes.byteLength, isInitSegment ? 1 : 0);
		} finally {
			Module._free(ptr);
		}
	}

	function reset() {
		Module._player_reset(handle);
	}

	function getCurrentTimeMs() {
		return Module._player_get_current_time(handle);
	}

	function destroy() {
		Module._player_destroy(handle);
	}

	return {
		Module,
		handle,
		feed,
		reset,
		destroy,
		getCurrentTimeMs
	};
}
```

## 回调数据格式说明

### `onVideoFrame(...)`

签名：

```js
onVideoFrame(width, height, yPtr, yStride, uPtr, uStride, vPtr, vStride, ptsMs, isKeyFrame, codecName)
```

字段说明：

| 参数 | 类型 | 说明 |
|------|------|------|
| `width` | `number` | 输出帧宽度 |
| `height` | `number` | 输出帧高度 |
| `yPtr/uPtr/vPtr` | `number` | YUV420P 三个平面在 wasm 堆里的起始地址 |
| `yStride/uStride/vStride` | `number` | 三个平面的 stride |
| `ptsMs` | `number` | 帧时间戳，单位毫秒 |
| `isKeyFrame` | `0 | 1` | 是否关键帧 |
| `codecName` | `string` | FFmpeg codec 名称，例如 `h264`、`hevc` |

注意：

- 当前视频统一输出为 `YUV420P`。
- 指针指向的是 wasm 内存，下一帧到来后数据可能被复用；如果上层要异步使用，必须在回调里立即拷贝。
- 如果你要交给 WebGL/WebCodecs/Canvas，自行决定是否在回调内转为 RGB、NV12 或纹理格式。

### `onAudioFrame(...)`

签名：

```js
onAudioFrame(channels, sampleRate, sampleCount, dataPtr, ptsMs, codecName)
```

字段说明：

| 参数 | 类型 | 说明 |
|------|------|------|
| `channels` | `number` | 声道数 |
| `sampleRate` | `number` | 采样率 |
| `sampleCount` | `number` | 每声道样本数 |
| `dataPtr` | `number` | 交错 `float32` PCM 在 wasm 堆中的起始地址 |
| `ptsMs` | `number` | 音频时间戳，单位毫秒 |
| `codecName` | `string` | FFmpeg codec 名称，例如 `aac` |

注意：

- 输出音频统一转换为交错布局的 `float32` PCM。
- 总采样数等于 `sampleCount * channels`。
- 同样需要在回调中立即拷贝，不能长期持有原始 `dataPtr`。

## 推荐的分片接入流程

### fMP4 HLS

这是当前最推荐的接入方式。

1. 解析 m3u8，拿到 `EXT-X-MAP`。
2. 请求并喂入 init segment，`isInitSegment = true`。
3. 顺序请求后续媒体分片或 LL-HLS parts，逐个 `isInitSegment = false` 喂入。
4. 切换清晰度、seek、时间轴跳变后，调用 `reset()`，然后重新从新的 init segment 开始。

### MPEG-TS HLS

如果分片本身包含足够的流信息，也可以直接喂媒体片段。但当前实现对 fMP4 更友好；在 TS 场景下，上层仍然需要保证分片顺序和时间轴相对稳定。

## 当前兼容和容错行为

当前解码器对浏览器侧使用有以下兼容逻辑：

- 遇到不支持的附加音视频流时，会跳过该流，而不是整段失败。
- 对废弃的全范围像素格式会归一化处理后再输出 `YUV420P`。
- 对常见的 LL-HLS / fMP4 时间戳跳变会尝试 flush 解码器状态。
- 在视频管线 flush 后，会等待下一个关键帧再恢复视频解码，避免把缺失参考链的 P/B 帧继续送入 HEVC。
- 对若干可恢复的 FFmpeg 噪声日志做了过滤，减少控制台干扰。

这意味着某些异常流在恢复阶段可能会丢掉一小段非关键帧视频，直到下一个 IDR 或关键帧到来。这是刻意的兼容策略，不是回调丢帧 bug。

## 常见问题

### 1. 为什么 `decoder.js` 能加载，但 `decoder.wasm` 404？

因为 wasm 的真实地址由 `locateFile('decoder.wasm')` 决定。部署到 CDN、静态资源目录或打包后路径变化时，必须显式传 `locateFile`。

### 2. 为什么不能直接把 `Uint8Array` 传给 `_player_feed_segment`？

因为 C 接口接收的是 wasm 堆指针，不是 JS 对象。必须先 `_malloc`，再把数据复制到 `Module.HEAPU8`。

### 3. 为什么拿到的 `yPtr`、`dataPtr` 不能长期缓存？

因为它们指向的是 wasm 线性内存。下一次解码、内存增长或缓冲复用后，原始区域可能被覆盖。需要在回调中立即拷贝到新的 `Uint8Array` 或 `Float32Array`。

### 4. 为什么视频在切流或 seek 后要等一下才恢复？

当前实现为了兼容 HEVC/H.264 参考帧链断裂，在 flush 后会等待关键帧再继续视频解码。没有关键帧时，音频可能已经恢复，但视频会等到可独立解码的帧再输出。

### 5. 控制台里还有 FFmpeg 日志，是否代表解码失败？

不一定。日志等级和失败并不一一对应。建议以上层是否持续收到 `onVideoFrame/onAudioFrame` 作为主要判断依据。`onLog` 更适合作为诊断辅助。

### 6. 可以直接在 `file://` 下打开页面测试吗？

不推荐。`decoder.wasm` 通常需要通过 HTTP 服务加载，尤其在现代浏览器和打包环境下更稳定。

## 最小封装建议

如果你在业务项目里使用，建议额外封装一层 `DecoderAdapter`，至少统一这几件事：

1. 模块初始化和销毁。
2. wasm 内存拷贝。
3. init segment 缓存和 reset 后重喂。
4. 视频 YUV 数据和音频 PCM 数据的复制。
5. 日志、错误码和统计信息上报。

## 对外 C API

底层 C 接口定义如下：

| 函数 | 说明 |
|------|------|
| `player_create()` | 创建解码器实例，返回句柄 |
| `player_destroy(handle)` | 销毁解码器实例 |
| `player_feed_segment(handle, data, size, is_init_segment)` | 喂入媒体数据段 |
| `player_reset(handle)` | 重置解码器状态 |
| `player_get_current_time(handle)` | 获取当前时间，单位毫秒 |

## 技术栈和编译参数

- 编译器：Emscripten (`em++`)
- C++ 标准：C++17
- 优化级别：`-Oz` + LTO + `--gc-sections`
- 内存模型：`emmalloc`
- 初始内存：128MB
- 最大内存：1GB，允许按需增长
- FFmpeg 版本：8.1
- 当前面向浏览器环境使用

## 环境要求

### Docker 构建

- Docker 20.10+
- Docker Compose v2

### 本地构建

- Emscripten SDK
- curl、make、autoconf、libtool 等构建工具
