/*
 * Automatic loudness matching. Ported unchanged from schwung-kit-builder's
 * tests/test_loudness.js (only the import path moved) — the matching math
 * doesn't care whether the readings came from Move's DSP or wav_rms.mjs.
 */
import { assert, eq } from './assert.js';
import { parseLoudness, matchGains } from '../core/loudness.mjs';

export const tests = [
    { name: 'parseLoudness -> 16 floats, junk/negatives become 0', fn() {
        const l = parseLoudness('0.10 0.20 0.0000 0.4  -1 x');
        eq(l.length, 16);
        eq(l[0], 0.10); eq(l[1], 0.20); eq(l[2], 0); eq(l[3], 0.4);
        eq(l[4], 0); eq(l[5], 0);            // "-1" and "x" -> 0
        eq(l[15], 0);
        eq(parseLoudness(null).every((x) => x === 0), true);
    }},

    { name: 'matchGains: attenuate-only — louder pads come down to a low percentile', fn() {
        const g = matchGains([0.1, 0.2, 0.4]);
        eq(g[0], 1.0);      // the quiet one is left alone
        eq(g[1], 0.5);      // 0.1 / 0.2
        eq(g[2], 0.25);     // 0.1 / 0.4
        for (let i = 3; i < 16; i++) eq(g[i], 1.0);
        assert(g.every((x) => x <= 1.0), 'nothing is boosted');
    }},

    { name: 'matchGains: empty / silent slots and quiet-but-present slots keep 1.0', fn() {
        const g = matchGains([0.2, 0, 0.05, 0]);
        eq(g[1], 1.0);
        eq(g[3], 1.0);
        eq(g[2], 1.0);              // quiet present slot is NOT boosted (attenuate-only)
        assert(g[0] < 1.0, 'the loud slot is pulled down');
    }},

    { name: 'matchGains: all-silent -> all 1.0', fn() {
        eq(matchGains([0, 0, 0]).every((x) => x === 1.0), true);
        eq(matchGains([]).every((x) => x === 1.0), true);
    }},

    { name: 'matchGains: minGain floor, and a very quiet sample is left at unity', fn() {
        const g = matchGains([0.005, 0.5, 0.1], { target: 0.02 });
        eq(g[0], 1.0);      // 0.02/0.005 = 4 -> would boost -> clamped to maxGain 1.0
        eq(g[1], 0.15);     // 0.02/0.5 = 0.04 -> below minGain 0.15
        eq(g[2], 0.2);      // 0.02/0.1
    }},

    { name: 'matchGains: opts can re-enable makeup boost', fn() {
        const g = matchGains([0.2, 0.1], { target: 0.2, minGain: 0.5, maxGain: 4 });
        eq(g[0], 1.0);
        eq(g[1], 2.0);     // 0.2/0.1 = 2, allowed by maxGain 4
    }},

    { name: 'matchGains: explicit percentile', fn() {
        const g = matchGains([0.1, 0.2, 0.3, 0.4], { percentile: 0.5 });
        eq(g[0], 1.0);     // 0.3/0.1 = 3 -> clamped to 1.0
        eq(g[1], 1.0);     // 0.3/0.2 = 1.5 -> clamped to 1.0
        eq(g[2], 1.0);
        eq(g[3], 0.75);    // 0.3/0.4
    }}
];
