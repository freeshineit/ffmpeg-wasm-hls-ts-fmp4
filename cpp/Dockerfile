# Dockerfile for hls-wasm2 WebAssembly build
# Uses Emscripten SDK to build FFmpeg and the decoder WASM module

FROM emscripten/emsdk:latest

LABEL description="hls-wasm2 WASM build environment"
LABEL maintainer="hls-wasm2"

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        bzip2 \
        autoconf \
        automake \
        libtool \
        pkg-config \
        make \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Copy project files
COPY . /workspace/

# Make scripts executable
RUN chmod +x /workspace/build_ffmpeg_wasm.sh

# Create output directories
RUN mkdir -p /workspace/build /workspace/third_party/ffmpeg-wasm

# Set default build target
CMD make all
