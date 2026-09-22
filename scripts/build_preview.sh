#!/usr/bin/env bash
# Build force-kit-builder's addon/host/preview_host for armhf, native-under-
# QEMU via Docker — same recipe as force-dx7/scripts/build.sh, not
# independently derived. Set CROSS_PREFIX to skip Docker if a real armhf
# toolchain is already available (e.g. building on a Pi).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE_NAME="force-kit-builder-preview-builder"

if [ -z "${CROSS_PREFIX:-}" ] && [ ! -f "/.dockerenv" ]; then
    echo "=== Force Kit Builder preview_host build (via Docker/QEMU armhf) ==="
    if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
        echo "Building Docker image (first time only)..."
        docker build --platform linux/arm/v7 -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT"
    fi
    docker run --rm --platform linux/arm/v7 \
        -v "$REPO_ROOT:/build" \
        -w /build \
        "$IMAGE_NAME" \
        ./scripts/build_preview.sh
    echo "=== Done: build/preview_host ==="
    exit 0
fi

cd "$REPO_ROOT"
mkdir -p build

echo "Compiling RtMidi..."
g++ -O2 -c -fPIC -std=c++14 -D__LINUX_ALSA__ addon/host/rtmidi/RtMidi.cpp -o build/RtMidi.o -Iaddon/host/rtmidi

echo "Compiling preview_host..."
g++ -O2 -fPIC -std=c++14 \
    -mcpu=cortex-a17 -mfpu=neon-vfpv4 -mfloat-abi=hard \
    addon/host/preview_host.cpp \
    build/RtMidi.o \
    -o build/preview_host \
    -Iaddon/host -Iaddon/host/rtmidi \
    -lasound -lpthread -lrt

echo ""
echo "=== Build complete: build/preview_host ==="
file build/preview_host 2>/dev/null || true
