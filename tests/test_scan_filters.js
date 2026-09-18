/*
 * Scan-time sample filters.
 */
import { assert, eq } from './assert.js';
import {
    looksLikeLoop, parseSizeBytes, makeScanFilter,
    SIZE_CAP_CHOICES, SIZE_CAP_LABELS
} from '../core/scan_filters.mjs';

export const tests = [
    { name: 'looksLikeLoop: name has "loop", a [bpm] tag, or "<n> bpm"', fn() {
        for (const n of ['Amen Loop.wav', 'drumloop_01.wav', 'beat [120].wav',
                         'groove[130bpm].wav', 'thing [90 bpm].aif', '128 BPM top.wav']) {
            assert(looksLikeLoop(n), n);
        }
        for (const n of ['Kick 01.wav', 'Snare_Deep.wav', 'clap.wav', 'hat[.wav', 'tom_a.aif']) {
            assert(!looksLikeLoop(n), n);
        }
    }},

    { name: 'parseSizeBytes: human strings, numbers, and rejects', fn() {
        eq(parseSizeBytes('2mb'), 2 * 1048576);
        eq(parseSizeBytes('1.5 MB'), Math.floor(1.5 * 1048576));
        eq(parseSizeBytes('500kb'), 500 * 1024);
        eq(parseSizeBytes('1gb'), 1073741824);
        eq(parseSizeBytes('4096'), 4096);          // bare number = bytes
        eq(parseSizeBytes(500000), 500000);
        eq(parseSizeBytes(null), null);
        eq(parseSizeBytes(''), null);
        eq(parseSizeBytes(0), null);
        eq(parseSizeBytes('huge'), null);
        eq(parseSizeBytes('-3mb'), null);
    }},

    { name: 'makeScanFilter: default = skip loops, no size cap', fn() {
        const f = makeScanFilter({});
        eq(f.skipLoops, true);
        eq(f.maxBytes, null);
        eq(f.reject('groove loop.wav', 10), 'loop');
        eq(f.reject('kick.wav', 999999999), null);       // no cap -> size never rejects
    }},

    { name: 'makeScanFilter: skip_loops:false keeps loops', fn() {
        const f = makeScanFilter({ scan_filters: { skip_loops: false } });
        eq(f.skipLoops, false);
        eq(f.reject('drum loop 01.wav', 10), null);
    }},

    { name: 'makeScanFilter: size cap rejects oversize only', fn() {
        const f = makeScanFilter({ scan_filters: { skip_loops: false, max_sample_size: '1mb' } });
        eq(f.maxBytes, 1048576);
        eq(f.reject('big.wav', 1048577), 'oversize');
        eq(f.reject('ok.wav', 1048576), null);           // exactly at the cap is fine
        eq(f.reject('ok.wav', 1000), null);
    }},

    { name: 'makeScanFilter: loop check wins over size check', fn() {
        const f = makeScanFilter({ scan_filters: { skip_loops: true, max_sample_size: '1mb' } });
        eq(f.reject('massive loop.wav', 5 * 1048576), 'loop');
    }},

    { name: 'SIZE_CAP choices/labels line up and start at Off/null', fn() {
        eq(SIZE_CAP_CHOICES.length, SIZE_CAP_LABELS.length);
        eq(SIZE_CAP_CHOICES[0], null);
        eq(SIZE_CAP_LABELS[0], 'Off');
        for (let i = 1; i < SIZE_CAP_CHOICES.length; i++) assert(parseSizeBytes(SIZE_CAP_CHOICES[i]) > 0);
    }}
];
