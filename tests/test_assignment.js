/*
 * Seeded random assignment engine. Ported from schwung-kit-builder's
 * tests/test_assignment.js. Each pad draws from a UNION of categories
 * (config.pad_layout); no fallback_roles.
 *
 * One test is adapted rather than ported verbatim: "source filter restricts
 * picks to the chosen library" used Move's fixed 'user'/'core'/'both' source
 * enum; this port has no such split (see core/random_assign.mjs's doc), so
 * the test now uses two arbitrary root-folder labels and 'all' in place of
 * 'both'. Every other test is unchanged (just the import paths moved).
 */
import { assert, eq } from './assert.js';
import { createKit } from '../core/kit_model.mjs';
import { assignKit, rerollPad, otherPoolCats, poolCatsForPad } from '../core/random_assign.mjs';
import { DEFAULT_CONFIG } from '../core/sample_index.mjs';

/* Build a fake index with `n` samples in each named category. */
function fakeIndex(spec) {
    const records = [];
    for (const cat of Object.keys(spec)) {
        for (let i = 1; i <= spec[cat]; i++) {
            records.push({
                filesystem_path: `/lib/${cat}/${cat}_${i}.wav`,
                source: 'library',
                category: cat,
                filename: `${cat}_${i}.wav`,
                extension: '.wav',
                size_bytes: 1000,
                modified_time: 0
            });
        }
    }
    return { records };
}

/* Enough in every pad-slot category + melodic categories for the Other pads. */
const FULL = fakeIndex({
    kick: 20, snare: 20, rim: 20, clap: 20, hat: 20, closed_hat: 20, open_hat: 20,
    tom: 20, conga: 20, percussion: 30, crash: 20, ride: 20, cymbal: 20, fx: 20,
    vox: 20, bass: 20, synth: 20, stab: 20, chord: 20, lead: 20, pad: 20, other: 40
});

/* Expected union pool per pad (mirrors DEFAULT_CONFIG.pad_layout, with the
 * "other" sentinel expanded). */
const OTHER = otherPoolCats(DEFAULT_CONFIG, DEFAULT_CONFIG.pad_layout);
const POOLS = [
    ['kick'], ['rim', 'snare'], ['snare'], ['clap', 'percussion'],
    ['percussion', 'tom', 'conga'],
    ['hat', 'closed_hat', 'open_hat'], ['closed_hat', 'hat'], ['open_hat', 'hat'],
    ['ride', 'cymbal', 'crash'], ['tom', 'percussion', 'conga'], ['percussion'], ['fx'],
    OTHER, OTHER, OTHER, OTHER
];

function mixedIndex() {
    const cats = ['kick', 'snare', 'rim', 'clap', 'hat', 'closed_hat', 'open_hat',
        'tom', 'conga', 'percussion', 'crash', 'ride', 'cymbal', 'fx',
        'vox', 'bass', 'synth', 'stab', 'chord', 'lead', 'pad', 'other'];
    const records = [];
    for (const src of ['/roots/aaa', '/roots/bbb']) {
        for (const cat of cats) {
            for (let i = 1; i <= 6; i++) {
                records.push({
                    filesystem_path: `${src}/${cat}/${cat}_${i}.wav`,
                    source: src, category: cat,
                    filename: `${cat}_${i}.wav`, extension: '.wav', size_bytes: 1000, modified_time: 0
                });
            }
        }
    }
    return { records };
}

function run(kit, index, over) {
    return assignKit(Object.assign({
        kit, index, config: DEFAULT_CONFIG, seed: 12345,
        source: 'all', preventDuplicates: true
    }, over));
}

export const tests = [
    { name: 'fills every unlocked pad that has a candidate', fn() {
        const res = run(createKit(DEFAULT_CONFIG), FULL);
        eq(res.pads.filter((p) => p.sample).length, 16);
        eq(res.unresolved.length, 0);
    }},

    { name: 'each pad draws from its category-union pool', fn() {
        const res = run(createKit(DEFAULT_CONFIG), FULL);
        for (let i = 0; i < 16; i++) {
            const cat = res.pads[i].sample.category;
            assert(POOLS[i].indexOf(cat) !== -1, `pad ${i + 1}: ${cat} not in [${POOLS[i]}]`);
        }
    }},

    { name: 'otherPoolCats = unslotted categories + fx', fn() {
        // fx has its own pad but also joins the Other pool
        for (const c of ['vox', 'bass', 'synth', 'stab', 'chord', 'lead', 'pad', 'other', 'fx']) {
            assert(OTHER.indexOf(c) !== -1, `Other pool missing ${c}`);
        }
        // no drum-slot category leaks into Other
        for (const c of ['kick', 'snare', 'rim', 'hat', 'closed_hat', 'tom', 'crash']) {
            assert(OTHER.indexOf(c) === -1, `${c} should not be in the Other pool`);
        }
        eq(poolCatsForPad(12, DEFAULT_CONFIG, OTHER), OTHER);   // pad 13 = sentinel
        eq(poolCatsForPad(0, DEFAULT_CONFIG, OTHER), ['kick']);
    }},

    { name: 'union pool actually mixes its categories over many seeds', fn() {
        const seen = new Set();
        for (let s = 1; s <= 60; s++) {
            const r = run(createKit(DEFAULT_CONFIG), FULL, { seed: s * 31 + 7 });
            seen.add(r.pads[1].sample.category);   // pad 2 = rim|snare
        }
        assert(seen.has('rim') && seen.has('snare'), `pad 2 only ever drew [${[...seen]}]`);
    }},

    { name: 'fx appears on pad 12 and can also land on the Other pads', fn() {
        let fxOnOther = false;
        for (let s = 1; s <= 80 && !fxOnOther; s++) {
            const r = run(createKit(DEFAULT_CONFIG), FULL, { seed: s * 17 + 1 });
            eq(r.pads[11].sample.category, 'fx');                       // pad 12 always fx
            for (let i = 12; i < 16; i++) if (r.pads[i].sample.category === 'fx') fxOnOther = true;
        }
        assert(fxOnOther, 'fx never showed up on an Other pad across 80 seeds');
    }},

    { name: 'same seed + same lock state -> identical result', fn() {
        const a = run(createKit(DEFAULT_CONFIG), FULL);
        const b = run(createKit(DEFAULT_CONFIG), FULL);
        eq(a.pads.map((p) => p.sample && p.sample.filesystem_path),
           b.pads.map((p) => p.sample && p.sample.filesystem_path));
    }},

    { name: 'no duplicate sample across pads when alternatives exist', fn() {
        const res = run(createKit(DEFAULT_CONFIG), FULL);
        const paths = res.pads.map((p) => p.sample.filesystem_path);
        eq(new Set(paths).size, 16);
    }},

    { name: 'locked pads never change; unlocked ones do', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        const cur = run(kit, FULL);
        for (let i = 0; i < 16; i++) kit.pads[i] = cur.pads[i];
        kit.pads[0].locked = true;
        kit.pads[12].locked = true;
        const lockedKick = kit.pads[0].sample.filesystem_path;
        const lockedOther = kit.pads[12].sample.filesystem_path;
        const before = kit.pads.map((p) => p.sample.filesystem_path);
        const res = run(kit, FULL, { seed: 999 });
        eq(res.pads[0].sample.filesystem_path, lockedKick);
        eq(res.pads[12].sample.filesystem_path, lockedOther);
        let changed = 0;
        for (let i = 0; i < 16; i++) if (res.pads[i].sample.filesystem_path !== before[i]) changed++;
        assert(changed > 0, 'expected some unlocked pads to change');
    }},

    { name: 'current sample not immediately reselected when alternatives exist', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        const res = run(kit, FULL, { seed: 1 });
        for (let i = 0; i < 16; i++) kit.pads[i] = res.pads[i];
        const kickBefore = kit.pads[0].sample.filesystem_path;
        let stayed = 0;
        for (let s = 1; s <= 40; s++) {
            const r = run(kit, FULL, { seed: s * 7 + 1 });
            if (r.pads[0].sample.filesystem_path === kickBefore) stayed++;
        }
        assert(stayed === 0, `kick pad kept its current sample ${stayed}/40 times (should be 0)`);
    }},

    { name: 'an empty pool leaves the pad unresolved (no fallback)', fn() {
        // kick + snare + a bit of "other" only — nothing for pads 4..12
        const idx = fakeIndex({ kick: 5, snare: 5, other: 50 });
        const res = run(createKit(DEFAULT_CONFIG), idx);
        const un = res.unresolved.map((u) => u.pad);
        // pad 4 = [clap, percussion] -> both empty -> unresolved
        assert(un.indexOf(4) !== -1, 'pad 4 should be unresolved');
        assert(un.indexOf(6) !== -1, 'pad 6 (hat) should be unresolved');
        assert(un.indexOf(12) !== -1, 'pad 12 (fx) should be unresolved');
        eq(res.pads[3].sample, null);
        // pads 1..3 resolve, pads 13..16 resolve from "other"
        assert(res.pads[0].sample && res.pads[1].sample && res.pads[2].sample);
        for (let i = 12; i < 16; i++) assert(res.pads[i].sample, `Other pad ${i + 1} should fill from "other"`);
        assert(res.warning && res.warning.includes('unavailable'), res.warning);
    }},

    { name: 'small pool relaxes duplicate-prevention and reports it', fn() {
        // pads 13..16 all draw the Other pool. fx=1 is claimed by pad 12 first,
        // leaving just other=2 unique samples for four Other pads -> relaxation.
        const idx = fakeIndex({
            kick: 5, snare: 5, rim: 5, clap: 5, hat: 5, closed_hat: 5, open_hat: 5,
            tom: 5, conga: 5, percussion: 8, crash: 5, ride: 5, cymbal: 5,
            fx: 1, other: 2
        });
        const res = run(createKit(DEFAULT_CONFIG), idx);
        assert(res.relaxed.length > 0, 'expected duplicate relaxation on the Other pads');
        for (let i = 12; i < 16; i++) assert(res.pads[i].sample, `pad ${i + 1} should be assigned`);
    }},

    { name: 'rerollPad changes one unlocked pad and avoids kit duplicates + current', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        const cur = run(kit, FULL);
        for (let i = 0; i < 16; i++) kit.pads[i] = cur.pads[i];
        const before = kit.pads.map((p) => p.sample.filesystem_path);
        const kickBefore = kit.pads[0].sample.filesystem_path;

        const r = rerollPad({ kit, index: FULL, config: DEFAULT_CONFIG, seed: 55, source: 'all', preventDuplicates: true, padIndex: 0 });
        assert(r.changed, 'pad 0 should change');
        eq(r.pad.sample.category, 'kick');
        assert(r.pad.sample.filesystem_path !== kickBefore, 'must not reselect the current sample');
        for (let i = 1; i < 16; i++) assert(r.pad.sample.filesystem_path !== before[i], `collides with pad ${i + 1}`);
        eq(kit.pads.map((p) => p.sample.filesystem_path), before);
    }},

    { name: 'rerollPad on a union-pool pad stays inside the pool', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        const cur = run(kit, FULL);
        for (let i = 0; i < 16; i++) kit.pads[i] = cur.pads[i];
        for (let s = 1; s <= 30; s++) {
            const r = rerollPad({ kit, index: FULL, config: DEFAULT_CONFIG, seed: s * 5 + 2, source: 'all', preventDuplicates: true, padIndex: 8 });
            if (r.pad && r.pad.sample) assert(POOLS[8].indexOf(r.pad.sample.category) !== -1, `pad 9 drew ${r.pad.sample.category}`);
        }
    }},

    { name: 'rerollPad never lands on a rejected sample', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        const cur = run(kit, FULL);
        for (let i = 0; i < 16; i++) kit.pads[i] = cur.pads[i];
        const rejects = new Set();
        for (const r of FULL.records) if (r.category === 'kick' && !/_(19|20)\.wav$/.test(r.filename)) rejects.add(r.filesystem_path);
        for (let s = 1; s <= 40; s++) {
            const r = rerollPad({ kit, index: FULL, config: DEFAULT_CONFIG, seed: s * 3 + 1, source: 'all', preventDuplicates: true, padIndex: 0, rejects });
            if (r.pad && r.pad.sample) assert(!rejects.has(r.pad.sample.filesystem_path), `reroll picked rejected ${r.pad.sample.filesystem_path}`);
        }
    }},

    { name: 'rerollPad refuses a locked pad', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        const cur = run(kit, FULL);
        for (let i = 0; i < 16; i++) kit.pads[i] = cur.pads[i];
        kit.pads[3].locked = true;
        const r = rerollPad({ kit, index: FULL, config: DEFAULT_CONFIG, seed: 1, source: 'all', preventDuplicates: true, padIndex: 3 });
        eq(r.changed, false);
        assert((r.warning || '').includes('locked'));
    }},

    { name: 'source filter restricts picks to the chosen root folder', fn() {
        const idx = mixedIndex();
        const a = run(createKit(DEFAULT_CONFIG), idx, { source: '/roots/aaa' });
        for (const p of a.pads) assert(!p.sample || p.sample.filesystem_path.startsWith('/roots/aaa/'), `aaa-only picked ${p.sample && p.sample.filesystem_path}`);

        const b = run(createKit(DEFAULT_CONFIG), idx, { source: '/roots/bbb' });
        for (const p of b.pads) assert(!p.sample || p.sample.filesystem_path.startsWith('/roots/bbb/'), `bbb-only picked ${p.sample && p.sample.filesystem_path}`);

        let sawA = false, sawB = false;
        for (let s = 1; s <= 30; s++) {
            const all = run(createKit(DEFAULT_CONFIG), idx, { source: 'all', seed: s * 17 + 3 });
            for (const p of all.pads) {
                if (p.sample && p.sample.filesystem_path.startsWith('/roots/aaa/')) sawA = true;
                if (p.sample && p.sample.filesystem_path.startsWith('/roots/bbb/')) sawB = true;
            }
        }
        assert(sawA && sawB, `'all' should mix roots (aaa=${sawA} bbb=${sawB})`);
    }},

    { name: 'rejects are never chosen; favourites come up more often', fn() {
        const idx = fakeIndex({
            kick: 6, snare: 6, rim: 6, clap: 6, hat: 6, closed_hat: 6, open_hat: 6,
            tom: 6, conga: 6, percussion: 8, crash: 6, ride: 6, cymbal: 6, fx: 6, other: 12
        });
        const rejects = new Set(['/lib/kick/kick_1.wav', '/lib/kick/kick_2.wav', '/lib/kick/kick_3.wav']);
        const favourites = new Set(['/lib/kick/kick_6.wav']);
        let favHits = 0;
        for (let s = 1; s <= 120; s++) {
            const res = assignKit({ kit: createKit(DEFAULT_CONFIG), index: idx, config: DEFAULT_CONFIG, seed: s * 13 + 1, source: 'all', preventDuplicates: true, rejects, favourites });
            const k = res.pads[0].sample.filesystem_path;
            assert(!rejects.has(k), `rejected sample ${k} was assigned`);
            if (k === '/lib/kick/kick_6.wav') favHits++;
        }
        assert(favHits > 40, `favourite only came up ${favHits}/120 times`);
    }}
];
