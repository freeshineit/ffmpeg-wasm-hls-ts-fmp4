#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
FFMPEG_OUT_DIR="${ROOT_DIR}/third_party/ffmpeg-wasm"
FFMPEG_VERSION="7.1"
BUILD_DIR="${ROOT_DIR}/build_ffmpeg"
FFMPEG_SRC_DIR="${ROOT_DIR}/ffmpeg-${FFMPEG_VERSION}"

if [[ ! -d "${FFMPEG_SRC_DIR}" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found. Please install curl first."
    exit 1
  fi

  mkdir -p "${BUILD_DIR}/src"
  FFMPEG_SRC_DIR="${BUILD_DIR}/src/ffmpeg-${FFMPEG_VERSION}"

  if [[ ! -d "${FFMPEG_SRC_DIR}" ]]; then
    echo "[1/3] Downloading FFmpeg ${FFMPEG_VERSION}..."
    cd "${BUILD_DIR}/src"
    curl -sL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2" -o ffmpeg.tar.bz2
    tar xjf ffmpeg.tar.bz2
    rm ffmpeg.tar.bz2
  fi
fi

if ! command -v emconfigure >/dev/null 2>&1; then
  echo "Emscripten not found. Please source emsdk_env.sh first."
  exit 1
fi

mkdir -p "${FFMPEG_OUT_DIR}"

echo "[2/3] Configuring FFmpeg..."
echo "Using FFmpeg source: ${FFMPEG_SRC_DIR}"
cd "${FFMPEG_SRC_DIR}"

emconfigure ./configure \
  --prefix="${FFMPEG_OUT_DIR}" \
  --cc=emcc \
  --cxx=em++ \
  --ar=emar \
  --ranlib=emranlib \
  --target-os=none \
  --arch=x86_64 \
  --enable-cross-compile \
  --disable-x86asm \
  --disable-inline-asm \
  --disable-autodetect \
  --disable-pthreads \
  --disable-runtime-cpudetect \
  --disable-programs \
  --disable-doc \
  --disable-network \
  --disable-avdevice \
  --disable-avfilter \
  --disable-postproc \
  --disable-hwaccels \
  --disable-iconv \
  --disable-zlib \
  --disable-bzlib \
  --disable-lzma \
  --enable-gpl \
  --enable-version3 \
  --enable-static \
  --disable-shared \
  --disable-debug \
  --enable-small \
  --disable-everything \
  --enable-protocol=file \
  --enable-demuxer=mov \
  --enable-demuxer=mpegts \
  --enable-parser=h264 \
  --enable-parser=hevc \
  --enable-decoder=h264 \
  --enable-decoder=hevc \
  --enable-decoder=aac \
  --enable-bsf=hevc_mp4toannexb \
  --enable-bsf=h264_mp4toannexb \
  --enable-bsf=extract_extradata \
  --enable-swresample \
  --enable-swscale \
  --extra-cflags="-Oz -ffunction-sections -fdata-sections" \
  --extra-cxxflags="-Oz -ffunction-sections -fdata-sections" \
  --extra-ldflags="-Wl,--gc-sections"

emmake make -j"$(sysctl -n hw.ncpu)"
emmake make install

echo "[3/3] Build finished."
echo "FFmpeg wasm build completed at ${FFMPEG_OUT_DIR}"
