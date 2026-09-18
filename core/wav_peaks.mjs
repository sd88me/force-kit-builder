/*
 * Force Kit Builder — server-side WAV waveform peaks (for the web UI's
 * per-pad and side-panel waveform preview).
 *
 * Companion to wav_rms.mjs: same rationale, same wavChunks()-based parser,
 * same format-support matrix. Computed server-side (not via the browser's
 * decodeAudioData()) because that API is strict about "valid" WAV shapes —
 * real-world sample-pack content commonly uses 24-bit PCM, extended `fmt `
 * headers, or BWF/broadcast metadata chunks that some browsers' decoders
 * simply refuse, even though the file is perfectly well-formed. The
 * hand-rolled parser here doesn't care, so this avoids a class of "waveform
 * just doesn't show up for this pad" bugs entirely rather than debugging
 * them browser-by-browser.
 *
 * Pure module: bytes in, peaks out.
 */

import { wavChunks } from './wav_info.mjs';

/* Extract channel-0 samples as floats in [-1, 1], one per audio frame
 * (skips interleaved channels 1..N-1 — this is a visual envelope, not a
 * downmix). Same format matrix as wav_rms.mjs's wavRms(). null for anything
 * else (compressed formats, a shape wavChunks() couldn't parse). */
function readChannel0(info) {
    const { bytes: b, audioFormat, channels, bitsPerSample, dataOffset, dataSize } = info;
    const bytesPerSample = bitsPerSample >> 3;
    if (!channels || !bytesPerSample) return null;
    const frameBytes = bytesPerSample * channels;
    const frameCount = Math.floor(dataSize / frameBytes);
    if (frameCount <= 0) return null;

    const view = new DataView(b.buffer, b.byteOffset + dataOffset, frameCount * frameBytes);
    const out = new Float32Array(frameCount);

    if (audioFormat === 3 && bitsPerSample === 32) {
        for (let f = 0; f < frameCount; f++) out[f] = view.getFloat32(f * frameBytes, true);
    } else if (audioFormat === 1 && bitsPerSample === 8) {
        for (let f = 0; f < frameCount; f++) out[f] = (view.getUint8(f * frameBytes) - 128) / 128;
    } else if (audioFormat === 1 && bitsPerSample === 16) {
        for (let f = 0; f < frameCount; f++) out[f] = view.getInt16(f * frameBytes, true) / 32768;
    } else if (audioFormat === 1 && bitsPerSample === 24) {
        for (let f = 0; f < frameCount; f++) {
            const o = f * frameBytes;
            let v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
            if (v & 0x800000) v -= 0x1000000;
            out[f] = v / 8388608;
        }
    } else if (audioFormat === 1 && bitsPerSample === 32) {
        for (let f = 0; f < frameCount; f++) out[f] = view.getInt32(f * frameBytes, true) / 2147483648;
    } else {
        return null;
    }
    return out;
}

/* wavPeaks(bytes, buckets) -> [{min,max}, ...] | null
 * Downsamples channel 0 into a fixed `buckets` {min,max} pairs across the
 * whole data chunk. Resolution is deliberately decoupled from any particular
 * canvas's pixel width — the client scales to fit (see client.js's
 * paintWaveform) — so one cached result serves both the small per-pad-tile
 * canvas and the larger side-panel one. */
export function wavPeaks(bytes, buckets) {
    const info = wavChunks(bytes);
    if (!info) return null;
    const samples = readChannel0(info);
    if (!samples || !samples.length) return null;

    const n = Math.max(1, buckets | 0);
    const per = Math.max(1, Math.floor(samples.length / n));
    const peaks = new Array(n);
    for (let i = 0; i < n; i++) {
        const start = i * per;
        const end = i === n - 1 ? samples.length : Math.min(samples.length, start + per);
        let min = 0, max = 0;
        for (let j = start; j < end; j++) {
            const v = samples[j];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        peaks[i] = { min, max };
    }
    return peaks;
}
