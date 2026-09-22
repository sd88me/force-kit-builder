# Build environment for force-kit-builder's addon/host/preview_host (v3
# audible pad preview, see DESIGN.md) — base copied from force-dx7/scripts/
# Dockerfile. preview_host has no MIDI (touchscreen-triggered, not RtMidi -
# see DESIGN.md's "v3 revision"), so libasound2-dev isn't actually needed
# here, unlike force-dx7's own copy of this file; left out. Akai Force is
# ARM 32-bit hard-float (ELF 32-bit LSB, ARM EABI5,
# /lib/ld-linux-armhf.so.3, "GNU/Linux 3.2.0").
#
# Native armhf build *under QEMU* (docker run --platform linux/arm/v7 needs
# binfmt_misc for arm registered on the host - Docker Desktop ships this; on
# a bare dockerd, run once:
#   docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
#
# Debian bookworm, not the older arm32v7/debian:stretch this project's
# earlier ports (force-acid/force-maze) use — checked directly against this
# Force over SSH: its real ceiling is glibc 2.39 / GLIBCXX 3.4.32, far newer
# than stretch's glibc 2.24 (see force-jv880/scripts/Dockerfile for the full
# writeup of that check). Re-verify the device's own ceiling before reusing
# this image for a different Force firmware build.
#
# No HAVE_NEON define anywhere in this build on purpose: msfa/fm_op_kernel.cc's
# NEON path is behind an explicit project-defined macro (unlike force-jv880's
# resampler, which used the compiler's automatic __ARM_NEON and hit a real
# AArch64-only intrinsic bug) — simply never defining it gets the portable
# scalar kernel with zero portability risk.
FROM debian:bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ \
        file \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
