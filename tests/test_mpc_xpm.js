/*
 * MPC .xpm export.
 */
import { assert, eq } from './assert.js';
import { createKit, sampleFromRecord } from '../core/kit_model.mjs';
import { DEFAULT_CONFIG } from '../core/sample_index.mjs';
import { buildXpm, exportXpm, mpcSampleName, manifestText } from '../exporters/mpc_xpm.mjs';

function rec(cat, name, root) {
    const base = root || '/samples';
    return {
        filesystem_path: `${base}/${cat}/${name}`,
        source: 'library', category: cat, filename: name, extension: '.wav'
    };
}
function kitWith(pairs, kitName) {
    const kit = createKit(DEFAULT_CONFIG);
    kit.name = kitName || 'Crunchy Kit';
    for (const [i, cat, name] of pairs) kit.pads[i].sample = sampleFromRecord(rec(cat, name));
    return kit;
}

export const tests = [
    { name: 'header + program name + drum type preserved from the template', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'bd.wav']], 'My Kit'));
        assert(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'xml decl');
        assert(text.includes('<Application>MPC-V</Application>'));
        assert(text.includes('<File_Version>2.1</File_Version>'));
        assert(text.includes('<Program type="Drum">'));
        assert(text.includes('<ProgramName>My Kit</ProgramName>'));
    }},

    { name: 'exactly 128 instruments, numbered 1..128', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'k.wav']]));
        const nums = (text.match(/<Instrument number="(\d+)">/g) || []).map((s) => +s.replace(/\D/g, ''));
        eq(nums.length, 128);
        eq(nums[0], 1);
        eq(nums[127], 128);
    }},

    { name: 'assigned pads get a Layer-1 SampleName; empty pads stay empty', fn() {
        const { text, padCount, manifest } = buildXpm(kitWith([
            [0, 'Kick', 'Big Kick.wav'], [1, 'Snare', 'snare 1.wav'], [15, 'Other', 'zap.wav']
        ], 'Kit A'));
        eq(padCount, 3);
        eq(manifest.map((m) => m.pad), [1, 2, 16]);
        assert(text.includes('<SampleName>Big Kick</SampleName>'), 'pad 1 name = source basename');
        assert(text.includes('<SampleName>snare 1</SampleName>'), 'pad 2 name');
        assert(text.includes('<SampleName>zap</SampleName>'), 'pad 16 name');
        assert(!text.includes('PRGKIT26BD1'), 'template placeholder leaked');
        const inst3 = text.slice(text.indexOf('<Instrument number="3">'), text.indexOf('<Instrument number="4">'));
        assert(inst3.includes('<SampleName></SampleName>'), 'pad 3 empty');
    }},

    { name: 'PadNoteMap: Note = (35 + pad) wrapped to 0..127, all 128 pads', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'k.wav']]));
        const map = text.slice(text.indexOf('<PadNoteMap>'), text.indexOf('</PadNoteMap>'));
        assert(map.includes('<PadNote number="1">\r\n        <Note>36</Note>'));
        assert(map.includes('<PadNote number="16">\r\n        <Note>51</Note>'));
        assert(map.includes('<PadNote number="92">\r\n        <Note>127</Note>'));
        assert(map.includes('<PadNote number="93">\r\n        <Note>0</Note>'));
        assert(map.includes('<PadNote number="128">\r\n        <Note>35</Note>'));
        eq((map.match(/<PadNote number=/g) || []).length, 128);
    }},

    { name: 'CRLF line endings on structure, closes cleanly', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'k.wav']]));
        assert(text.includes('<Program type="Drum">\r\n'), 'crlf on structure');
        assert(text.endsWith('  </Program>\r\n</MPCVObject>\r\n'), JSON.stringify(text.slice(-40)));
        assert(text.includes('<QLinkAssignments/>'), 'self-closed qlink');
        assert(text.includes('<ProgramPads-v2.10>{\n'), 'progpads body is LF');
        assert(text.includes('}</ProgramPads-v2.10>\r\n'), 'progpads closes with CRLF');
    }},

    { name: 'mpcSampleName: source basename only, no extension, spaces kept, capped', fn() {
        eq(mpcSampleName('Deep Kick 01.wav'), 'Deep Kick 01');
        eq(mpcSampleName('a/b\\c.aif'), 'c');                    // basename, ext dropped
        eq(mpcSampleName('Kick (Hard).wav'), 'Kick (Hard)');     // spaces + parens kept
        eq(mpcSampleName('808 Boom!.wav'), '808 Boom');          // unsafe punctuation -> _, trailing trimmed
        assert(mpcSampleName('a really quite long sample name that runs past the forty-two cap.wav').length <= 42);
    }},

    { name: 'exportXpm requires a destination dir', fn() {
        const r = exportXpm(kitWith([[0, 'Kick', 'k.wav']]), { name: 'No Dir', write: () => true });
        eq(r.ok, false);
        assert(r.errors.join(' ').includes('destination directory'));
    }},

    { name: 'exportXpm writes .xpm + MANIFEST, makes the folder, reports path', fn() {
        const FS = new Map(); const DIRS = [];
        const kit = kitWith([[0, 'Kick', 'k.wav'], [4, 'Closed Hat', 'ch.wav']], 'RT Kit');
        const r = exportXpm(kit, {
            dir: '/exp/MPC', name: 'RT Kit',
            mkdir: (p) => DIRS.push(p),
            write: (p, s) => { FS.set(p, s); return true; }
        });
        assert(r.ok, JSON.stringify(r.errors));
        eq(r.path, '/exp/MPC/RT Kit/RT Kit.xpm');
        eq(r.padCount, 2);
        eq(r.gathered, 0);              // no copy() supplied
        assert(DIRS.includes('/exp/MPC/RT Kit'));
        assert(FS.has('/exp/MPC/RT Kit/MANIFEST.txt'));
        const man = FS.get('/exp/MPC/RT Kit/MANIFEST.txt');
        assert(man.includes('place each source file'), 'manual-gather header');
        assert(man.includes('k.wav\t/samples/Kick/k.wav'));
        assert(man.includes('ch.wav\t/samples/Closed Hat/ch.wav'));
        assert(!man.includes('[gathered]'), 'no gather tags without copy()');
    }},

    { name: 'buildXpm manifest carries ext + destName (source ext kept, .wav default)', fn() {
        const kit = kitWith([[0, 'Kick', 'bd.wav'], [1, 'Perc', 'shk.AIF']], 'Ext');
        kit.pads[2].sample = sampleFromRecord(rec('Other', 'noext'));   // no dot in name
        const { manifest } = buildXpm(kit);
        eq(manifest.map((m) => m.ext), ['.wav', '.aif', '.wav']);
        eq(manifest.map((m) => m.destName), ['bd.wav', 'shk.aif', 'noext.wav']);
    }},

    { name: 'exportXpm with copy() gathers each sample beside the .xpm', fn() {
        const FS = new Map(); const COPIES = [];
        const kit = kitWith([[0, 'Kick', 'k.wav'], [4, 'Closed Hat', 'ch.wav']], 'G Kit');
        const r = exportXpm(kit, {
            dir: '/exp/MPC', name: 'G Kit',
            write: (p, s) => { FS.set(p, s); return true; },
            copy: (src, dest) => { COPIES.push([src, dest]); return true; }
        });
        assert(r.ok, JSON.stringify(r.errors));
        eq(r.gathered, 2);
        eq(r.warnings.length, 0);
        eq(COPIES, [
            ['/samples/Kick/k.wav', '/exp/MPC/G Kit/k.wav'],
            ['/samples/Closed Hat/ch.wav', '/exp/MPC/G Kit/ch.wav']
        ]);
        const man = FS.get('/exp/MPC/G Kit/MANIFEST.txt');
        assert(man.includes('were copied next to this .xpm'), 'gathered header');
        assert(man.includes('k.wav\t/samples/Kick/k.wav\t[gathered]'));
        assert(man.includes('ch.wav\t/samples/Closed Hat/ch.wav\t[gathered]'));
    }},

    { name: 'exportXpm: a failed copy is non-fatal — warned + tagged MISSING', fn() {
        const FS = new Map();
        const kit = kitWith([[0, 'Kick', 'k.wav'], [1, 'Snare', 'sn.wav']], 'P Kit');
        const r = exportXpm(kit, {
            dir: '/exp/MPC', name: 'P Kit',
            write: (p, s) => { FS.set(p, s); return true; },
            copy: (src) => src.indexOf('sn.wav') === -1     // snare copy fails
        });
        assert(r.ok, 'still ok — MANIFEST is the fallback');
        eq(r.gathered, 1);
        assert(r.warnings.some((w) => w.indexOf('could not copy') !== -1 && w.indexOf('sn.wav') !== -1), r.warnings.join('|'));
        const man = FS.get('/exp/MPC/P Kit/MANIFEST.txt');
        assert(man.includes('k.wav\t') && man.includes('[gathered]'));
        assert(/sn\.wav\t.*\[MISSING/.test(man), man);
    }},

    { name: 'exportXpm: non-.wav source warns (MPC wants a .wav beside the .xpm)', fn() {
        const kit = kitWith([[0, 'Kick', 'boom.aiff']], 'A Kit');
        const r = exportXpm(kit, {
            dir: '/x', name: 'A Kit',
            write: () => true,
            copy: () => true
        });
        assert(r.ok);
        eq(r.gathered, 1);
        assert(r.warnings.some((w) => w.indexOf('.aiff') !== -1 && w.indexOf('boom.wav') !== -1), r.warnings.join('|'));
    }},

    { name: 'manifestText: attempted vs manual header + tags', fn() {
        const m = [{ pad: 1, sampleName: 'K-01-a', sourcePath: '/s/a.wav', ext: '.wav', destName: 'K-01-a.wav', gathered: true },
                   { pad: 2, sampleName: 'K-02-b', sourcePath: '/s/b.wav', ext: '.wav', destName: 'K-02-b.wav', gathered: false }];
        const manual = manifestText(m);
        assert(manual.includes('place each source file'));
        assert(manual.includes('K-01-a.wav\t/s/a.wav\n'), JSON.stringify(manual));
        assert(!manual.includes('[gathered]'));
        const done = manifestText(m, { attempted: true });
        assert(done.includes('K-01-a.wav\t/s/a.wav\t[gathered]'));
        assert(/K-02-b\.wav\t\/s\/b\.wav\t\[MISSING/.test(done), done);
    }},

    { name: 'an all-empty kit is refused', fn() {
        const r = exportXpm(createKit(DEFAULT_CONFIG), { dir: '/x', name: 'E', write: () => { throw new Error('no'); } });
        eq(r.ok, false);
        assert(r.errors.join(' ').includes('no assigned pads'));
    }},

    { name: 'frameCount() sets Layer-1 SliceEnd to the real frame count', fn() {
        const kit = kitWith([[0, 'Kick', 'k.wav'], [1, 'Snare', 'sn.wav']], 'FC Kit');
        const lengths = { '/samples/Kick/k.wav': 33688, '/samples/Snare/sn.wav': 12000 };
        const { text, warnings } = buildXpm(kit, { frameCount: (p) => lengths[p] || null });
        eq(warnings.length, 0);
        const inst1 = text.slice(text.indexOf('<Instrument number="1">'), text.indexOf('<Instrument number="2">'));
        const inst2 = text.slice(text.indexOf('<Instrument number="2">'), text.indexOf('<Instrument number="3">'));
        assert(inst1.includes('<SliceEnd>33688</SliceEnd>'), inst1);
        assert(inst2.includes('<SliceEnd>12000</SliceEnd>'), inst2);
    }},

    { name: 'no frameCount() supplied -> SliceEnd stays 0, no warning (matches old callers)', fn() {
        const { text, warnings } = buildXpm(kitWith([[0, 'Kick', 'k.wav']], 'No FC'));
        eq(warnings.length, 0);
        const inst1 = text.slice(text.indexOf('<Instrument number="1">'), text.indexOf('<Instrument number="2">'));
        assert(inst1.includes('<SliceEnd>0</SliceEnd>'), inst1);
    }},

    { name: 'frameCount() returning null/0 for a pad warns and leaves that pad\'s SliceEnd 0', fn() {
        const kit = kitWith([[0, 'Kick', 'k.wav'], [1, 'Snare', 'sn.wav']], 'Partial FC');
        const { text, warnings } = buildXpm(kit, {
            frameCount: (p) => (p.indexOf('sn.wav') !== -1 ? null : 5000)
        });
        assert(warnings.some((w) => w.indexOf('pad 2') !== -1 && w.indexOf('could not read sample length') !== -1), warnings.join('|'));
        const inst1 = text.slice(text.indexOf('<Instrument number="1">'), text.indexOf('<Instrument number="2">'));
        const inst2 = text.slice(text.indexOf('<Instrument number="2">'), text.indexOf('<Instrument number="3">'));
        assert(inst1.includes('<SliceEnd>5000</SliceEnd>'), inst1);
        assert(inst2.includes('<SliceEnd>0</SliceEnd>'), inst2);
    }},

    { name: 'exportXpm forwards opts.frameCount through to buildXpm', fn() {
        const FS = new Map();
        const kit = kitWith([[0, 'Kick', 'k.wav']], 'RT FC');
        const r = exportXpm(kit, {
            dir: '/exp/MPC', name: 'RT FC',
            write: (p, s) => { FS.set(p, s); return true; },
            frameCount: () => 4096
        });
        assert(r.ok, JSON.stringify(r.errors));
        const xpm = FS.get('/exp/MPC/RT FC/RT FC.xpm');
        const inst1 = xpm.slice(xpm.indexOf('<Instrument number="1">'), xpm.indexOf('<Instrument number="2">'));
        assert(inst1.includes('<SliceEnd>4096</SliceEnd>'), inst1);
    }},

    { name: 'duplicate sample on two pads still yields distinct SampleNames', fn() {
        const { text, manifest } = buildXpm(kitWith([[0, 'Kick', 'boom.wav'], [1, 'Kick', 'boom.wav']], 'Dup'));
        const names = manifest.map((m) => m.sampleName);
        eq(names.length, 2);
        assert(names[0] === 'boom', names[0]);
        assert(names[0] !== names[1], names.join(' == '));    // 2nd disambiguated (e.g. "boom 2")
        for (const nm of names) assert(text.includes(`<SampleName>${nm}</SampleName>`), `missing ${nm}`);
    }}
];
