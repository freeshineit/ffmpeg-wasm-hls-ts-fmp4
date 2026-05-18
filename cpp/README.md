# hls-wasm2 — C++ WebAssembly 解码器

基于 FFmpeg + Emscripten 的 HLS 解码器，将 C++ 编译为 WebAssembly，在浏览器中实现音视频解码。

## 项目结构

```
cpp/
├── src/
│   └── decoder.cpp          # 解码器核心实现
├── include/
│   └── decoder.h            # 解码器头文件（C API）
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

## 构建方式

### 方式一：Docker 构建（推荐）

无需安装 Emscripten SDK，只需 Docker 即可完成构建。

```bash
# 完整构建（FFmpeg + decoder WASM）
./docker-build.sh

# 或使用 Makefile
make docker-build
```

**分步构建：**

```bash
# 仅构建 FFmpeg 依赖（首次较慢，约 10-20 分钟）
./docker-build.sh ffmpeg

# 仅构建 decoder WASM（依赖已构建的 FFmpeg）
./docker-build.sh wasm

# 将产物复制到 web 项目
./docker-build.sh install-web
```

**其他命令：**

```bash
# 进入 Docker 构建环境的交互式 shell
./docker-build.sh shell

# 清理构建产物
./docker-build.sh clean
```

#### 使用 Docker Compose 直接操作

```bash
# 完整构建
docker compose run --rm build

# 仅构建 FFmpeg
docker compose run --rm build-ffmpeg

# 仅构建 WASM
docker compose run --rm build-wasm

# 交互式 shell
docker compose run --rm shell
```

### 方式二：本地构建

需要预先安装 [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)。

```bash
# 激活 Emscripten 环境
source /path/to/emsdk/emsdk_env.sh

# 完整构建
make all

# 分步构建
make ffmpeg    # 构建 FFmpeg 依赖
make wasm      # 构建 decoder WASM

# 清理
make clean
```

## 构建产物

| 文件 | 说明 |
|------|------|
| `build/decoder.js` | Emscripten 生成的 JS 胶水代码（modularized） |
| `build/decoder.wasm` | WebAssembly 二进制文件 |

## 导出 API

解码器对外暴露以下 C 函数：

| 函数 | 说明 |
|------|------|
| `player_create()` | 创建解码器实例，返回句柄 |
| `player_destroy(handle)` | 销毁解码器实例 |
| `player_feed_segment(handle, data, size, is_init)` | 喂入媒体数据段 |
| `player_reset(handle)` | 重置解码器状态 |

## 技术栈

- **编译器**: Emscripten (emcc/em++)
- **C++ 标准**: C++17
- **优化级别**: `-Oz` + LTO + GC sections
- **内存模型**: `emmalloc`，初始 128MB，按需增长至 1GB
- **FFmpeg 版本**: 8.1（精简配置，仅包含 H.264/H.265/AAC 解码器）

## 环境要求

### Docker 构建
- Docker 20.10+
- Docker Compose v2（`docker compose`）

### 本地构建
- Emscripten SDK（latest）
- curl、make、autoconf、libtool 等构建工具
