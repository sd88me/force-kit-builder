/*
 * Force Kit Builder — server-side WAV loudness (RMS) measurement.
 *
 * loudness.mjs needs a real loudness reading per pad to work from. There's
 * no native DSP here to get one for free, so this reads each pad's own WAV
 * file directly (via wav_info.mjs's chunk walker) and computes RMS as a
 * fraction of full scale, entirely server-side in Node — no Web Audio API,
 * no browser round-trip, works headless exactly like the rest of this addon.
 *
 * Pure module: bytes in, number out. Supports the PCM shapes real sample
 * libraries actually use: 8-bit unsigned, 16/24/32-bit signed integer, and
 * 32-bit float. Anything else (compressed formats, a shape wavChunks() can't
 * parse) returns null — the caller (storage/loudness call site) leaves that
 * pad's gain at 1.0 for an unmeasurable sample.
 */

import { wavChunks } from './wav_info.mjs';

/* wavRms(bytes) -> number | null
 * RMS over the entire data chunk (all channels interleaved, not per-channel —
 * good enough for the attenuate-only matching in loudness.mjs, which only
 * needs a relative loudness ranking across pads, not a broadcast-accurate
 * measurement). */
export function wavRms(bytes) {
    const info = wavChunks(bytes);
    if (!info) return null;
    const { bytes: b, audioFormat, bitsPerSample, dataOffset, dataSize } = info;
    if (dataSize <= 0) return null;

    let sumSquares = 0;
    let n = 0;

    if (audioFormat === 3 && bitsPerSample === 32) {
        // IEEE float32, already -1..1
        const view = new DataView(b.buffer, b.byteOffset + dataOffset, dataSize - (dataSize % 4));
        for (let i = 0; i + 4 <= view.byteLength; i += 4) {
            const v = view.getFloat32(i, true);
            sumSquares += v * v;
            n++;
        }
    } else if (audioFormat === 1 && bitsPerSample === 8) {
        // Unsigned 8-bit, centre at 128
        const end = dataOffset + dataSize;
        for (let i = dataOffset; i < end; i++) {
            const v = (b[i] - 128) / 128;
            sumSquares += v * v;
            n++;
        }
    } else if (audioFormat === 1 && bitsPerSample === 16) {
        const view = new DataView(b.buffer, b.byteOffset + dataOffset, dataSize - (dataSize % 2));
        for (let i = 0; i + 2 <= view.byteLength; i += 2) {
            const v = view.getInt16(i, true) / 32768;
            sumSquares += v * v;
            n++;
        }
    } else if (audioFormat === 1 && bitsPerSample === 24) {
        const end = dataOffset + dataSize - (dataSize % 3);
        for (let i = dataOffset; i + 3 <= end; i += 3) {
            let v = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
            if (v & 0x800000) v -= 0x1000000;          // sign-extend 24-bit
            sumSquares += (v / 8388608) * (v / 8388608);
            n++;
        }
    } else if (audioFormat === 1 && bitsPerSample === 32) {
        const view = new DataView(b.buffer, b.byteOffset + dataOffset, dataSize - (dataSize % 4));
        for (let i = 0; i + 4 <= view.byteLength; i += 4) {
            const v = view.getInt32(i, true) / 2147483648;
            sumSquares += v * v;
            n++;
        }
    } else {
        return null;   // unsupported format (e.g. compressed WAV)
    }

    if (!n) return null;
    return Math.sqrt(sumSquares / n);
}
