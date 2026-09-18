/*
 * New module (no Move equivalent): server-side WAV waveform peaks, used by
 * the web UI's per-pad and side-panel waveform preview instead of the
 * browser's decodeAudioData() — see wav_peaks.mjs's doc for why.
 */
import { assert, eq } from './assert.js';
import { wavPeaks } from '../core/wav_peaks.mjs';

const enc = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

function wav(chunks) {
    let body = [];
    for (const [id, data] of chunks) {
        body = body.concat(enc(id), u32(data.length), data);
        if (data.length & 1) body.push(0);
    }
    return Uint8Array.from(enc('RIFF').concat(u32(4 + body.length), enc('WAVE'), body));
}

function fmt(channels, bitsPerSample, audioFormat) {
    const blockAlign = channels * (bitsPerSample / 8);
    const byteRate = 44100 * blockAlign;
    const af = audioFormat || 1;
    return [af & 0xff, (af >> 8) & 0xff]
        .concat([channels & 0xff, (channels >> 8) & 0xff])
        .concat(u32(44100))
        .concat(u32(byteRate))
        .concat([blockAlign & 0xff, (blockAlign >> 8) & 0xff])
        .concat([bitsPerSample & 0xff, (bitsPerSample >> 8) & 0xff]);
}

function int16le(v) { return [v & 0xff, (v >> 8) & 0xff]; }
function int32le(v) {
    const u = v >>> 0;
    return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff];
}
function int24le(v) {
    const u = v & 0xffffff;
    return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff];
}
function float32le(v) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    return Array.from(new Uint8Array(buf));
}

export const tests = [
    { name: '16-bit PCM ramp -> plausible min/max peaks', fn() {
        // 200 frames, alternating +32767 / -32767 (full-scale square wave)
        const samples = [];
        for (let i = 0; i < 200; i++) samples.push(...int16le(i % 2 ? 32767 : -32767));
        const bytes = wav([['fmt ', fmt(1, 16)], ['data', samples]]);
        const peaks = wavPeaks(bytes, 8);
        assert(Array.isArray(peaks) && peaks.length === 8, `expected 8 buckets, got ${peaks && peaks.length}`);
        for (const p of peaks) {
            assert(p.max > 0.99 && p.max <= 1.0, `expected max ~1.0, got ${p.max}`);
            assert(p.min < -0.99 && p.min >= -1.0, `expected min ~-1.0, got ${p.min}`);
        }
    }},

    { name: '8-bit unsigned PCM -> non-null peaks', fn() {
        const samples = [];
        for (let i = 0; i < 200; i++) samples.push(i % 2 ? 255 : 0);
        const bytes = wav([['fmt ', fmt(1, 8)], ['data', samples]]);
        const peaks = wavPeaks(bytes, 8);
        assert(Array.isArray(peaks) && peaks.length === 8, 'expected 8 buckets');
        assert(peaks.some((p) => p.max > 0.9), 'expected at least one near-full-scale peak');
    }},

    { name: '24-bit signed PCM -> non-null peaks', fn() {
        const samples = [];
        for (let i = 0; i < 200; i++) samples.push(...int24le(i % 2 ? 8388607 : -8388608));
        const bytes = wav([['fmt ', fmt(1, 24)], ['data', samples]]);
        const peaks = wavPeaks(bytes, 8);
        assert(Array.isArray(peaks) && peaks.length === 8, 'expected 8 buckets');
        assert(peaks.every((p) => p.max > 0.99 && p.min < -0.99), 'expected near-full-scale peaks throughout');
    }},

    { name: '32-bit signed PCM -> non-null peaks', fn() {
        const samples = [];
        for (let i = 0; i < 200; i++) samples.push(...int32le(i % 2 ? 2147483647 : -2147483648));
        const bytes = wav([['fmt ', fmt(1, 32)], ['data', samples]]);
        const peaks = wavPeaks(bytes, 8);
        assert(Array.isArray(peaks) && peaks.length === 8, 'expected 8 buckets');
        assert(peaks.every((p) => p.max > 0.99 && p.min < -0.99), 'expected near-full-scale peaks throughout');
    }},

    { name: '32-bit float PCM -> non-null peaks', fn() {
        const samples = [];
        for (let i = 0; i < 200; i++) samples.push(...float32le(i % 2 ? 1.0 : -1.0));
        const bytes = wav([['fmt ', fmt(1, 32, 3 /* IEEE float */)], ['data', samples]]);
        const peaks = wavPeaks(bytes, 8);
        assert(Array.isArray(peaks) && peaks.length === 8, 'expected 8 buckets');
        assert(peaks.every((p) => p.max === 1.0 && p.min === -1.0), 'expected exact +/-1.0 peaks');
    }},

    { name: 'not a well-formed WAV -> null', fn() {
        eq(wavPeaks(Uint8Array.from(enc('not a wav')), 8), null);
    }},

    { name: 'unsupported audioFormat -> null (e.g. compressed WAV)', fn() {
        const bytes = wav([['fmt ', fmt(1, 16, 6 /* A-law */)], ['data', new Array(100).fill(0)]]);
        eq(wavPeaks(bytes, 8), null);
    }},

    { name: 'requesting more buckets than frames does not crash', fn() {
        const samples = [];
        for (let i = 0; i < 3; i++) samples.push(...int16le(1000));
        const bytes = wav([['fmt ', fmt(1, 16)], ['data', samples]]);
        const peaks = wavPeaks(bytes, 128);
        assert(Array.isArray(peaks) && peaks.length === 128, `expected 128 buckets, got ${peaks && peaks.length}`);
    }}
];
