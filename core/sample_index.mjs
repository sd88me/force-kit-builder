/*
 * Force Kit Builder — sample index: recursive sample-folder scan,
 * classification, cached index file.
 *
 * Plain Node `fs` sync calls throughout — this runs inside nodeServer's own
 * Node process, so there's no host-shim layer to abstract. `sample_roots` is
 * `string[]` — an arbitrary, user-selected list of folders (picked via the
 * file-browser widget in the web UI). Each record's `source` is stamped
 * with the *root path itself* (not a fixed library tag), so random_assign's
 * per-root filter still works. There's no `sample.ableton_uri` field in this
 * data model (see kit_model.mjs). The data directory (KB_DIR and friends) is
 * not a hardcoded path — call `configureDataDir(dir)` once at startup (the
 * plugin's index.js does this, pointing at a folder inside its own install).
 *
 * The chunked step(budget) scanner is kept even though Node has no UI thread
 * to protect — nodeServer is a single-threaded process serving every other
 * addon page too, so a scan still shouldn't hog the event loop on a huge
 * sample library.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildAliasIndex, classify } from './sample_classifier.mjs';
import { makeScanFilter } from './scan_filters.mjs';
import { DEFAULT_PAD_LAYOUT } from './kit_model.mjs';

/* Writable Kit Builder data area. Defaults to ./data next to this module;
 * the plugin's index.js overrides this once at startup via
 * configureDataDir() to point inside its own nodeServer install location. */
export let KB_DIR = new URL('../data', import.meta.url).pathname;
export let INDEX_PATH = path.join(KB_DIR, '.sample-index.json');
export let INDEX_TMP = INDEX_PATH + '.tmp';
export let CONFIG_PATH = path.join(KB_DIR, 'config.json');

export function configureDataDir(dir) {
    KB_DIR = dir;
    INDEX_PATH = path.join(KB_DIR, '.sample-index.json');
    INDEX_TMP = INDEX_PATH + '.tmp';
    CONFIG_PATH = path.join(KB_DIR, 'config.json');
}

/*
 * Default configuration. A user config.json (if present) overrides this.
 * `sample_roots` starts empty — the web UI's source picker is how a root
 * folder gets added, there's no sensible Force-wide default to guess (see
 * DESIGN.md's open item on Force library-path conventions).
 */
export const DEFAULT_CONFIG = {
    schema_version: 1,
    sample_roots: [],
    supported_extensions: ['.wav', '.aif', '.aiff'],
    scan_filters: { skip_loops: true, max_sample_size: null },
    /* When a folder path doesn't classify a sample, fall back to a keyword
     * match on its filename. Set false to keep folder-only. */
    classify_filenames: true,
    /* Classification vocabulary (folder aliases only; pad placement lives in
     * `pad_layout`). Order matters: buildAliasIndex is first-writer-wins, so
     * `shaker` (listed under both `hat` and `percussion`) resolves to `hat`. */
    role_rules: {
        kick:       { folder_aliases: ['kick', 'kicks', 'kck', 'bd', 'bass drum'] },
        snare:      { folder_aliases: ['snare', 'snares', 'snr', 'sd'] },
        rim:        { folder_aliases: ['rim', 'rims', 'rimshot', 'rimshots', 'side stick'] },
        clap:       { folder_aliases: ['clap', 'claps', 'clp', 'cp', 'hand clap'] },
        hat:        { folder_aliases: ['hat', 'hats', 'hihat', 'hihats', 'hi hat', 'hi hats', 'hh', 'shaker', 'shakers'] },
        closed_hat: { folder_aliases: ['closed hat', 'closed hats', 'closed hihat', 'closed hihats', 'closed hh', 'hihat closed', 'hh closed', 'ch', 'chh', 'hh c', 'hat c'] },
        open_hat:   { folder_aliases: ['open hat', 'open hats', 'open hihat', 'open hihats', 'open hh', 'hihat open', 'hh open', 'oh', 'ohh', 'hh o', 'hat o'] },
        tom:        { folder_aliases: ['tom', 'toms', 'floor', 'rack', 'rototom', 'rototoms', 'timbale', 'timbales'] },
        conga:      { folder_aliases: ['conga', 'congas'] },
        percussion: { folder_aliases: ['percussion', 'perc', 'percs', 'tambourine', 'tambourines', 'tamb', 'cowbell', 'cowbells', 'bongo', 'bongos', 'agogo', 'woodblock', 'woodblocks', 'wood', 'block', 'triangle', 'triangles', 'cabasa', 'maracas', 'guiro', 'guiros', 'claves', 'shaker', 'shakers'] },
        crash:      { folder_aliases: ['crash', 'crashes'] },
        ride:       { folder_aliases: ['ride', 'rides'] },
        cymbal:     { folder_aliases: ['cymbal', 'cymbals', 'cym'] },
        fx:         { folder_aliases: ['fx', 'sfx', 'effect', 'effects', 'sound fx', 'sound effects', 'noise', 'noises', 'foley', 'impact', 'impacts', 'hit', 'hits', 'riser', 'risers', 'sweep', 'sweeps', 'transition', 'transitions'] },
        glitch:     { folder_aliases: ['glitch', 'glitches', 'glitchy', 'grain', 'grains', 'granular'] },
        vox:        { folder_aliases: ['vox', 'vocal', 'vocals', 'voice', 'voices', 'chant', 'chants', 'choir'] },
        bass:       { folder_aliases: ['bass', 'basses', 'sub', 'subs'] },
        synth:      { folder_aliases: ['synth', 'synths', 'synthesizer', 'analog'] },
        stab:       { folder_aliases: ['stab', 'stabs', 'chord hit'] },
        chord:      { folder_aliases: ['chord', 'chords'] },
        lead:       { folder_aliases: ['lead', 'leads', 'melody', 'melodic', 'melodies'] },
        pad:        { folder_aliases: ['pad', 'pads', 'atmosphere', 'ambient', 'texture', 'textures', 'drone', 'drones', 'strings', 'keys', 'piano', 'organ', 'brass'] },
        other:      { folder_aliases: ['other'] }
    },
    /* Which categories each pad draws from — a union pool, uniform pick.
     * `["other"]` = every category with no dedicated pad slot, plus `fx`. */
    pad_layout: DEFAULT_PAD_LAYOUT.map((e) => e.slice())
};

/* Every classification category, in a stable order (drives emptyCounts). */
export const ROLE_ORDER = [
    'kick', 'snare', 'rim', 'clap', 'hat', 'closed_hat', 'open_hat',
    'tom', 'conga', 'percussion', 'crash', 'ride', 'cymbal', 'fx', 'glitch',
    'vox', 'bass', 'synth', 'stab', 'chord', 'lead', 'pad', 'other'
];

/* SYSTEM/status-panel display buckets. Anything not listed here — the
 * melodic categories plus `other` — rolls into the "Other" line. */
export const SYSTEM_BUCKETS = [
    { key: 'kick',  label: 'Kick', cats: ['kick'] },
    { key: 'snare', label: 'Snr',  cats: ['snare', 'rim'] },
    { key: 'clap',  label: 'Clap', cats: ['clap'] },
    { key: 'hats',  label: 'Hats', cats: ['hat', 'closed_hat', 'open_hat'] },
    { key: 'toms',  label: 'Tom',  cats: ['tom', 'conga'] },
    { key: 'perc',  label: 'Perc', cats: ['percussion'] },
    { key: 'cym',   label: 'Cym',  cats: ['crash', 'ride', 'cymbal'] },
    { key: 'fx',    label: 'FX',   cats: ['fx'] }
];

export function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            return mergeConfig(DEFAULT_CONFIG, parsed);
        }
    } catch (e) {
        console.log('force-kit-builder: config.json unreadable, using defaults (' + e + ')');
    }
    return DEFAULT_CONFIG;
}

function mergeConfig(base, over) {
    const out = JSON.parse(JSON.stringify(base));
    if (over && typeof over === 'object') {
        if (Array.isArray(over.sample_roots)) out.sample_roots = over.sample_roots.slice();
        if (Array.isArray(over.supported_extensions)) out.supported_extensions = over.supported_extensions.slice();
        if (over.scan_filters && typeof over.scan_filters === 'object') {
            out.scan_filters = Object.assign({}, out.scan_filters, over.scan_filters);
        }
        if (Array.isArray(over.pad_layout) && over.pad_layout.length === 16) {
            out.pad_layout = over.pad_layout.map((e) => (Array.isArray(e) ? e.slice() : ['other']));
        }
        if (over.role_rules && typeof over.role_rules === 'object') {
            for (const role of Object.keys(over.role_rules)) {
                out.role_rules[role] = Object.assign({}, out.role_rules[role], over.role_rules[role]);
            }
        }
        for (const k of Object.keys(over)) {
            if (['sample_roots', 'supported_extensions', 'scan_filters', 'pad_layout', 'role_rules'].indexOf(k) === -1) out[k] = over[k];
        }
    }
    return out;
}

/* ---- stat/readdir helpers (plain Node fs) ---------------------------- */

function statOf(p) {
    try { return fs.statSync(p); } catch (e) { return null; }
}
function readdirOf(p) {
    try { return fs.readdirSync(p); } catch (e) { return []; }
}

/* ---- chunked scanner ------------------------------------------------- */

/*
 * createScan(config) -> {
 *   step(budget): process up to `budget` entries, return phase
 *   state: live progress object
 * }
 * phase: 'scanning' | 'done' | 'error'
 */
export function createScan(config) {
    const cfg = config || DEFAULT_CONFIG;
    const rootPaths = Array.isArray(cfg.sample_roots) ? cfg.sample_roots : [];
    const exts = (cfg.supported_extensions || []).map((e) => String(e).toLowerCase());
    const aliasIndex = buildAliasIndex(cfg.role_rules);
    const scanFilter = makeScanFilter(cfg);
    const useFilenames = cfg.classify_filenames !== false;

    const roots = [];
    for (const p of rootPaths) {
        if (!p) continue;
        const prefix = String(p).replace(/\/+$/, '');
        const st = statOf(prefix);
        if (st && st.isDirectory()) roots.push({ prefix, source: prefix });
    }

    const state = {
        phase: roots.length ? 'scanning' : 'error',
        error: roots.length ? null : 'no_root',
        roots,
        stack: roots.map((r) => r.prefix),
        records: [],
        counts: emptyCounts(),
        countsByRoot: {},
        skippedLoops: 0,
        skippedOversize: 0,
        dirsVisited: 0,
        filesSeen: 0,
        indexPath: null,
        startedMs: Date.now(),
        finishedMs: 0
    };

    function rootFor(full) {
        for (const r of state.roots) {
            if (full === r.prefix || full.startsWith(r.prefix + '/')) return r;
        }
        return null;
    }

    function step(budget) {
        if (state.phase !== 'scanning') return state.phase;
        let work = 0;
        const max = budget > 0 ? budget : 250;
        while (state.stack.length && work < max) {
            const dir = state.stack.pop();
            state.dirsVisited++;
            const names = readdirOf(dir);
            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                if (name === '.' || name === '..') continue;
                if (name.charAt(0) === '.') continue;              // hidden / temp
                work++;
                const full = path.join(dir, name);
                const st = statOf(full);
                if (!st) continue;
                if (st.isDirectory()) { state.stack.push(full); continue; }

                state.filesSeen++;
                const lower = name.toLowerCase();
                if (lower.endsWith('.tmp')) continue;
                const dot = lower.lastIndexOf('.');
                const ext = dot >= 0 ? lower.slice(dot) : '';
                if (exts.indexOf(ext) === -1) continue;

                const rej = scanFilter.reject(name, st.size || 0);
                if (rej === 'loop') { state.skippedLoops++; continue; }
                if (rej === 'oversize') { state.skippedOversize++; continue; }

                const root = rootFor(full);
                if (!root) continue;
                const rel = full.slice(root.prefix.length + 1);
                const parts = rel.split(path.sep);
                const dirParts = parts.slice(0, -1);
                const role = classify(dirParts, aliasIndex, useFilenames ? name : undefined);

                state.records.push({
                    filesystem_path: full,
                    source: root.source,
                    category: role,
                    filename: name,
                    extension: ext,
                    size_bytes: st.size || 0,
                    modified_time: st.mtimeMs ? Math.floor(st.mtimeMs / 1000) : 0
                });
                state.counts[role] = (state.counts[role] || 0) + 1;
                state.countsByRoot[root.source] = (state.countsByRoot[root.source] || 0) + 1;
            }
        }
        if (!state.stack.length) {
            state.phase = 'done';
            state.finishedMs = Date.now();
            try {
                state.indexPath = writeIndex(state);
            } catch (e) {
                state.phase = 'error';
                state.error = 'write_failed';
                console.log('force-kit-builder: index write failed: ' + e);
            }
        }
        return state.phase;
    }

    return { step, state };
}

function emptyCounts() {
    const c = {};
    for (const r of ROLE_ORDER) c[r] = 0;
    return c;
}

/* Atomic-ish write: tmp -> parse-check -> rename. */
function writeIndex(state) {
    fs.mkdirSync(KB_DIR, { recursive: true });
    const payload = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        sample_roots: (state.roots || []).map((r) => r.prefix),
        counts_by_root: state.countsByRoot || {},
        skipped_loops: state.skippedLoops || 0,
        skipped_oversize: state.skippedOversize || 0,
        count: state.records.length,
        counts: state.counts,
        records: state.records
    };
    const json = JSON.stringify(payload);
    fs.writeFileSync(INDEX_TMP, json);
    JSON.parse(fs.readFileSync(INDEX_TMP, 'utf8')); // validate before rename
    fs.renameSync(INDEX_TMP, INDEX_PATH);
    return INDEX_PATH;
}

/* Load a previously written index. Returns null if absent/bad. */
export function loadIndex() {
    try {
        if (!fs.existsSync(INDEX_PATH)) return null;
        const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
        if (!parsed || !Array.isArray(parsed.records)) return null;
        if (!parsed.counts) {
            parsed.counts = emptyCounts();
            for (const rec of parsed.records) parsed.counts[rec.category] = (parsed.counts[rec.category] || 0) + 1;
        }
        if (typeof parsed.skipped_loops !== 'number') parsed.skipped_loops = 0;
        if (typeof parsed.skipped_oversize !== 'number') parsed.skipped_oversize = 0;
        return parsed;
    } catch (e) {
        console.log('force-kit-builder: cached index malformed, will rebuild (' + e + ')');
        return null;
    }
}

/* Condensed counts for the status panel — the SYSTEM_BUCKETS plus a
 * catch-all `other` (melodic categories + unclassified). */
export function summarize(counts) {
    const c = counts || emptyCounts();
    const indexed = ROLE_ORDER.reduce((n, r) => n + (c[r] || 0), 0);
    const out = { indexed };
    let bucketed = 0;
    for (const b of SYSTEM_BUCKETS) {
        const n = b.cats.reduce((s, cat) => s + (c[cat] || 0), 0);
        out[b.key] = n;
        bucketed += n;
    }
    out.other = indexed - bucketed;
    return out;
}

/* Category summary limited to one root ('all' or an exact root path).
 * Recomputed from records so the status panel reflects the chosen source. */
export function summarizeRecords(records, source) {
    const c = emptyCounts();
    const byRoot = {};
    for (const r of records || []) {
        byRoot[r.source] = (byRoot[r.source] || 0) + 1;
        if (source && source !== 'all' && r.source !== source) continue;
        c[r.category] = (c[r.category] || 0) + 1;
    }
    const s = summarize(c);
    s.byRoot = byRoot;
    return s;
}
