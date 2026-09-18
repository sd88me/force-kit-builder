/*
 * Server-side WAV RMS measurement used by "Match Levels" — no native DSP
 * here, so this is how a pad's loudness gets measured.
 */
import { assert, eq } from './assert.js';
import { wavRms } from '../core/wav_rms.mjs';

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

export const tests = [
    { name: 'silence -> RMS 0', fn() {
        const bytes = wav([['fmt ', fmt(1, 16)], ['data', new Array(2000).fill(0)]]);
        eq(wavRms(bytes), 0);
    }},

    { name: 'full-scale square wave (+/-32767) -> RMS close to 1.0', fn() {
        const samples = [];
        for (let i = 0; i < 1000; i++) samples.push(...int16le(i % 2 ? 32767 : -32767));
        const bytes = wav([['fmt ', fmt(1, 16)], ['data', samples]]);
        const r = wavRms(bytes);
        assert(r > 0.99 && r <= 1.0, `expected ~1.0, got ${r}`);
    }},

    { name: 'half-scale constant value -> RMS ~= 0.5', fn() {
        const samples = [];
        for (let i = 0; i < 1000; i++) samples.push(...int16le(16384));
        const bytes = wav([['fmt ', fmt(1, 16)], ['data', samples]]);
        const r = wavRms(bytes);
        assert(Math.abs(r - 0.5) < 0.01, `expected ~0.5, got ${r}`);
    }},

    { name: '8-bit unsigned PCM is centred at 128', fn() {
        // alternating 0 / 255 == full-scale square wave in 8-bit unsigned terms
        const samples = [];
        for (let i = 0; i < 1000; i++) samples.push(i % 2 ? 255 : 0);
        const bytes = wav([['fmt ', fmt(1, 8)], ['data', samples]]);
        const r = wavRms(bytes);
        assert(r > 0.99 && r <= 1.0, `expected ~1.0, got ${r}`);
    }},

    { name: 'not a well-formed WAV -> null', fn() {
        eq(wavRms(Uint8Array.from(enc('not a wav'))), null);
    }},

    { name: 'unsupported audioFormat -> null (e.g. compressed WAV)', fn() {
        const bytes = wav([['fmt ', fmt(1, 16, 6 /* A-law */)], ['data', new Array(100).fill(0)]]);
        eq(wavRms(bytes), null);
    }}
];
