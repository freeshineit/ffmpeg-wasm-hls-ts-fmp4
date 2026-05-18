#!/usr/bin/env bash
# docker-build.sh - Convenience wrapper for Docker-based WASM builds
#
# Usage:
#   ./docker-build.sh              # Full build: FFmpeg + decoder WASM
#   ./docker-build.sh ffmpeg       # Build only FFmpeg
#   ./docker-build.sh wasm         # Build only decoder WASM
#   ./docker-build.sh install-web  # Copy WASM to web project
#   ./docker-build.sh shell        # Open a shell in the build container
#   ./docker-build.sh clean        # Clean build outputs
#
# Requirements:
#   - Docker
#   - Docker Compose (v2: docker compose)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"

# Detect docker compose command (v1 vs v2)
if command -v docker &> /dev/null && docker compose version &> /dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
else
    echo "Error: docker compose or docker-compose not found."
    echo "Please install Docker Desktop or docker-compose."
    exit 1
fi

print_usage() {
    echo "Usage: $0 [target]"
    echo ""
    echo "Targets:"
    echo "  (default)     Full build: FFmpeg + decoder WASM"
    echo "  ffmpeg        Build only FFmpeg dependencies"
    echo "  wasm          Build only decoder WASM (requires pre-built FFmpeg)"
    echo "  install-web   Copy WASM output to web project"
    echo "  shell         Open interactive shell in build container"
    echo "  clean         Remove build outputs"
    echo ""
}

case "${1:-all}" in
    all|build)
        echo "==> Full build: FFmpeg + decoder WASM"
        ${DOCKER_COMPOSE} build build
        ${DOCKER_COMPOSE} run --rm build
        echo "==> Build complete!"
        echo "    Output files:"
        echo "      $(pwd)/build/decoder.js"
        echo "      $(pwd)/build/decoder.wasm"
        ;;
    ffmpeg)
        echo "==> Building FFmpeg only"
        ${DOCKER_COMPOSE} build build
        ${DOCKER_COMPOSE} run --rm build-ffmpeg
        echo "==> FFmpeg build complete!"
        echo "    Output: $(pwd)/third_party/ffmpeg-wasm/"
        ;;
    wasm)
        echo "==> Building decoder WASM only"
        ${DOCKER_COMPOSE} build build
        ${DOCKER_COMPOSE} run --rm build-wasm
        echo "==> WASM build complete!"
        echo "    Output files:"
        echo "      $(pwd)/build/decoder.js"
        echo "      $(pwd)/build/decoder.wasm"
        ;;
    install-web)
        echo "==> Installing WASM to web project"
        ${DOCKER_COMPOSE} build build
        ${DOCKER_COMPOSE} run --rm install-web
        echo "==> Installation complete!"
        ;;
    shell)
        echo "==> Starting interactive shell"
        ${DOCKER_COMPOSE} build build
        ${DOCKER_COMPOSE} run --rm shell
        ;;
    clean)
        echo "==> Cleaning build outputs"
        rm -rf "${SCRIPT_DIR}/build" "${SCRIPT_DIR}/third_party/ffmpeg-wasm"
        echo "==> Clean complete!"
        ;;
    -h|--help|help)
        print_usage
        ;;
    *)
        echo "Error: Unknown target '$1'"
        print_usage
        exit 1
        ;;
esac
