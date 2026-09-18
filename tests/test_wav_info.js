/*
 * WAV frame counting (fixes the MPC .xpm SliceEnd bug — a pad with
 * SliceStart 0 / SliceEnd 0 is a zero-length region and played silence on a
 * real Akai Force). Ported from schwung-kit-builder's tests/test_wav_info.js;
 * the base64Decode() tests are dropped since that function no longer exists
 * in this port (Node's fs.readFileSync needs no base64 round-trip — see
 * core/wav_info.mjs's doc).
 */
import { assert, eq } from './assert.js';
import { wavFrameCount } from '../core/wav_info.mjs';

const enc = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

/* Build a RIFF/WAVE from [id, bytesArray] chunks. */
function wav(chunks) {
    let body = [];
    for (const [id, data] of chunks) {
        body = body.concat(enc(id), u32(data.length), data);
        if (data.length & 1) body.push(0);           // word-align pad
    }
    return Uint8Array.from(enc('RIFF').concat(u32(4 + body.length), enc('WAVE'), body));
}

/* fmt chunk: PCM, channels, sampleRate(fixed 44100), blockAlign, bitsPerSample */
function fmt(channels, bitsPerSample) {
    const blockAlign = channels * (bitsPerSample / 8);
    const byteRate = 44100 * blockAlign;
    return enc('\x01\x00')                       // AudioFormat = 1 (PCM)
        .concat([channels & 0xff, (channels >> 8) & 0xff])
        .concat(u32(44100))
        .concat(u32(byteRate))
        .concat([blockAlign & 0xff, (blockAlign >> 8) & 0xff])
        .concat([bitsPerSample & 0xff, (bitsPerSample >> 8) & 0xff]);
}

function silence(nBytes) { return new Array(nBytes).fill(0); }

export const tests = [
    { name: 'mono 16-bit: frames = dataBytes / 2', fn() {
        const bytes = wav([['fmt ', fmt(1, 16)], ['data', silence(2000)]]);
        eq(wavFrameCount(bytes), 1000);
    }},

    { name: 'stereo 16-bit: frames = dataBytes / 4', fn() {
        const bytes = wav([['fmt ', fmt(2, 16)], ['data', silence(4000)]]);
        eq(wavFrameCount(bytes), 1000);
    }},

    { name: 'stereo 24-bit: frames = dataBytes / 6', fn() {
        const bytes = wav([['fmt ', fmt(2, 24)], ['data', silence(6006)]]);
        eq(wavFrameCount(bytes), 1001);
    }},

    { name: 'matches the real-reference value (33688 frames, mono 16-bit)', fn() {
        // Same shape as the genuine MPC export xpm_template.mjs was built from
        // (its Layer-1 SliceEnd is 33688 for this sample).
        const bytes = wav([['fmt ', fmt(1, 16)], ['data', silence(33688 * 2)]]);
        eq(wavFrameCount(bytes), 33688);
    }},

    { name: 'a LIST/INFO chunk before data does not throw off the count', fn() {
        const LIST = enc('INFOISFT' + '\x08\x00\x00\x00' + 'Ableton\x00');
        const bytes = wav([['fmt ', fmt(1, 16)], ['LIST', LIST], ['data', silence(200)]]);
        eq(wavFrameCount(bytes), 100);
    }},

    { name: 'odd-length data chunk (word-align pad) still counts correctly', fn() {
        const bytes = wav([['fmt ', fmt(1, 8)], ['data', silence(101)]]);
        eq(wavFrameCount(bytes), 101);
    }},

    { name: 'not RIFF/WAVE -> null (e.g. an AIFF, or garbage)', fn() {
        eq(wavFrameCount(Uint8Array.from(enc('FORM____AIFF'))), null);
        eq(wavFrameCount(Uint8Array.from([1, 2, 3])), null);
        eq(wavFrameCount(new Uint8Array(0)), null);
    }},

    { name: 'RIFF/WAVE with no data chunk -> null', fn() {
        const bytes = wav([['fmt ', fmt(1, 16)]]);
        eq(wavFrameCount(bytes), null);
    }},

    { name: 'a fmt chunk with 0 channels/bits -> null (not a divide-by-zero)', fn() {
        const bytes = wav([['fmt ', fmt(0, 0)], ['data', silence(10)]]);
        eq(wavFrameCount(bytes), null);
    }},

    { name: 'truncated file (chunk claims more than is present) -> null', fn() {
        const good = wav([['fmt ', fmt(1, 16)], ['data', silence(200)]]);
        const truncated = good.subarray(0, good.length - 50);
        eq(wavFrameCount(truncated), null);
    }}
];
