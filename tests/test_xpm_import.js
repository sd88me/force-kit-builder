/*
 * parseXpm() — reading an existing .xpm back out (the "Load XPM" feature).
 * See exporters/mpc_xpm.mjs's doc comment for the v1 Instrument-N=pad-N
 * limitation this relies on.
 */
import { assert, eq } from './assert.js';
import { parseXpm, buildXpm } from '../exporters/mpc_xpm.mjs';
import { createKit, sampleFromRecord } from '../core/kit_model.mjs';
import { DEFAULT_CONFIG } from '../core/sample_index.mjs';

function synthXpm(instruments) {
    // Minimal synthetic XPM: just enough structure for parseXpm to exercise —
    // real files carry far more per-instrument XML, parseXpm only looks for
    // <Instrument number="n">...<Layer number="1">...<SampleName>.
    const blocks = instruments.map(([n, sampleName]) => `
      <Instrument number="${n}">
        <Layers>
          <Layer number="1">
            <SampleName>${sampleName}</SampleName>
          </Layer>
          <Layer number="2">
            <SampleName>should-be-ignored</SampleName>
          </Layer>
        </Layers>
      </Instrument>`).join('');
    return `<?xml version="1.0"?>\n<MPCVObject><Program type="Drum">\n    <ProgramName>Synth &amp; Test</ProgramName>\n    <Instruments>${blocks}\n    </Instruments>\n  </Program></MPCVObject>`;
}

export const tests = [
    { name: 'parseXpm: minimal synthetic file, ProgramName unescaped, ignores Layer 2+', fn() {
        const xml = synthXpm([[1, 'Kick One'], [2, ''], [3, 'Snare Two']]);
        const r = parseXpm(xml);
        eq(r.name, 'Synth & Test');
        eq(r.pads[0], { padNum: 1, sampleName: 'Kick One' });
        eq(r.pads[1], { padNum: 2, sampleName: '' });
        eq(r.pads[2], { padNum: 3, sampleName: 'Snare Two' });
        eq(r.pads[3], null);
        eq(r.pads.length, 16);
    }},

    { name: 'parseXpm: stops at Instrument 16, ignores anything past it', fn() {
        const xml = synthXpm([[1, 'a'], [16, 'p16'], [17, 'p17-should-not-appear']]);
        const r = parseXpm(xml);
        eq(r.pads[15], { padNum: 16, sampleName: 'p16' });
    }},

    { name: 'parseXpm: garbage/empty input never throws, yields null name and 16 null pads', fn() {
        for (const input of ['', 'not xml at all', null, undefined, '<Instrument number="abc">']) {
            const r = parseXpm(input);
            eq(r.name, null);
            eq(r.pads.length, 16);
            assert(r.pads.every((p) => p === null), JSON.stringify(r.pads));
        }
    }},

    { name: 'parseXpm round-trips this exporter\'s own buildXpm() output', fn() {
        function rec(cat, name) {
            return { filesystem_path: `/samples/${cat}/${name}`, source: 'lib', category: cat, filename: name, extension: '.wav' };
        }
        const kit = createKit(DEFAULT_CONFIG);
        kit.name = 'Round Trip Test';
        kit.pads[0].sample = sampleFromRecord(rec('Kick', 'Big Kick.wav'));
        kit.pads[3].sample = sampleFromRecord(rec('Snare', 'snare 1.wav'));
        kit.pads[15].sample = sampleFromRecord(rec('Other', 'zap.wav'));
        const { text } = buildXpm(kit);
        const r = parseXpm(text);
        eq(r.name, 'Round Trip Test');
        eq(r.pads[0].sampleName, 'Big Kick');
        eq(r.pads[3].sampleName, 'snare 1');
        eq(r.pads[15].sampleName, 'zap');
        eq(r.pads[1].sampleName, '');   // empty pad -> empty string, not null (Instrument 2 exists in a real 128-instrument export)
        eq(r.pads[2].sampleName, '');
    }}
];
