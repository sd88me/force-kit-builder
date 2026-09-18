/*
 * Force Kit Builder — storage: working kit JSON, atomic-ish writes, load +
 * validate, kit-name generation, preferences.
 *
 * Plain Node `fs` sync calls throughout — no host-shim layer to abstract, and
 * no base64 binary-safety hazard to work around: `fs.readFileSync` returns a
 * real Buffer directly, so `wav_rms.mjs`/`wav_info.mjs` just read it — no
 * encoding round-trip at all. Keeps only the MPC `.xpm` exporter (no Ableton
 * drum-rack `.ablpreset` export path here). There is no SSH-push-to-device
 * subsystem — moot once the tool runs natively on the Force and writes XPMs
 * straight to local disk. `exportMpcXpm(kit, name, destDir)` takes the
 * destination directory as a required argument rather than a hardcoded
 * default path — the web UI's destination-folder picker supplies it. See
 * DESIGN.md's open item: which on-disk location the Force's own Program
 * browser expects XPM kits in is NOT YET CONFIRMED on real hardware, so this
 * deliberately has no baked-in "correct" default to fall back on.
 * `fs.copyFileSync` here is an exact byte-for-byte copy with no
 * metadata-stripping step needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { KB_DIR, CONFIG_PATH } from './sample_index.mjs';
import { DEFAULT_PAD_LAYOUT } from './kit_model.mjs';
import { validateKit } from './validation.mjs';
import { wavFrameCount } from './wav_info.mjs';
import { exportXpm as buildAndWriteXpm } from '../exporters/mpc_xpm.mjs';

export function kitsDir() { return path.join(KB_DIR, 'Kits'); }
export function currentKitPath() { return path.join(KB_DIR, 'current-kit.json'); }
export function prefsPath() { return path.join(KB_DIR, 'preferences.json'); }

/* ---- fs helpers (thin wrappers so call sites read like the original) --- */

function hRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function hWrite(p, s) { try { fs.writeFileSync(p, s); return true; } catch (e) { return false; } }
function hExists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function hMkdir(p) { fs.mkdirSync(p, { recursive: true }); }

/* ---- kit name ------------------------------------------------------- */

export function pad3(n) { return String(Math.max(0, n | 0)).padStart(3, '0'); }

export function todayIsoDate(now) {
    return (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
}

export function generatedKitName(counter, now) {
    return `Kit Builder ${pad3(counter)} ${todayIsoDate(now)}`;
}

/* ---- config.json counter --------------------------------------------- */

export function readRawConfig() {
    try {
        const raw = hRead(CONFIG_PATH);
        if (raw) {
            const o = JSON.parse(raw);
            if (o && typeof o === 'object') return o;
        }
    } catch (e) { /* fall through */ }
    return {};
}

export function nextKitNumber() {
    const n = parseInt(readRawConfig().next_kit_number, 10);
    return (Number.isFinite(n) && n >= 1) ? n : 1;
}

/* Persist the counter so the NEXT save uses `used + 1`. Call only after a
 * successful save. Returns the new value, or null on failure. */
export function commitKitNumber(used) {
    const cfg = readRawConfig();
    cfg.next_kit_number = (parseInt(used, 10) || 1) + 1;
    hMkdir(KB_DIR);
    return writeJsonAtomic(CONFIG_PATH, cfg) ? cfg.next_kit_number : null;
}

/* Scan-time filters, persisted in config.json under `scan_filters` — the
 * same key sample_index.loadConfig() merges, so a Rescan picks it up. */
const SCAN_FILTER_DEFAULTS = { skip_loops: true, max_sample_size: null };

export function loadScanPrefs() {
    const sf = readRawConfig().scan_filters || {};
    return {
        skip_loops: typeof sf.skip_loops === 'boolean' ? sf.skip_loops : SCAN_FILTER_DEFAULTS.skip_loops,
        max_sample_size: (sf.max_sample_size === null || typeof sf.max_sample_size === 'string' || typeof sf.max_sample_size === 'number')
            ? sf.max_sample_size : SCAN_FILTER_DEFAULTS.max_sample_size
    };
}

export function saveScanPrefs(prefs) {
    const cfg = readRawConfig();
    cfg.scan_filters = Object.assign({}, SCAN_FILTER_DEFAULTS, cfg.scan_filters, prefs || {});
    hMkdir(KB_DIR);
    return writeJsonAtomic(CONFIG_PATH, cfg);
}

/* Sample-root folders selected via the web UI's source picker, persisted so
 * they survive a nodeServer restart. */
export function loadSampleRoots() {
    const roots = readRawConfig().sample_roots;
    return Array.isArray(roots) ? roots.slice() : [];
}

export function saveSampleRoots(roots) {
    const cfg = readRawConfig();
    cfg.sample_roots = Array.isArray(roots) ? roots.slice() : [];
    hMkdir(KB_DIR);
    return writeJsonAtomic(CONFIG_PATH, cfg);
}

/*
 * Override which categories one pad slot draws from — this is what the web
 * UI's per-pad pool picker writes to. Config-wide, not per-kit: it changes
 * which pool that pad slot pulls from
 * for every future Assign/Reroll, on any kit, until changed again.
 */
export function savePadLayoutEntry(padIndex, categories) {
    const cfg = readRawConfig();
    const layout = (Array.isArray(cfg.pad_layout) && cfg.pad_layout.length === 16)
        ? cfg.pad_layout.map((e) => (Array.isArray(e) ? e.slice() : ['other']))
        : DEFAULT_PAD_LAYOUT.map((e) => e.slice());
    layout[padIndex] = (Array.isArray(categories) && categories.length) ? categories.slice() : ['other'];
    cfg.pad_layout = layout;
    hMkdir(KB_DIR);
    return writeJsonAtomic(CONFIG_PATH, cfg) ? layout : null;
}

/* ---- filename sanitisation -------------------------------------------- */

export function sanitizeFilename(name) {
    let s = String(name == null ? '' : name);
    s = s.replace(/[\x00-\x1f\x7f]/g, '');   // control characters
    s = s.replace(/[\/\\]/g, '');                   // path separators — first, so
    s = s.replace(/\.{2,}/g, '.');                  // then "../.." collapses to one dot
    s = s.replace(/[<>:"|?*]/g, '_');               // invalid filename chars
    s = s.replace(/^\s+|\s+$/g, '');                // trim surrounding whitespace only
    if (!s || /^\.+$/.test(s)) s = 'Kit Builder';   // empty or dots-only -> fallback
    return s;
}

/* ---- atomic-ish JSON write --------------------------------------------- */

export function writeJsonAtomic(finalPath, obj) {
    let json;
    try { json = JSON.stringify(obj, null, 2); } catch (e) { return false; }
    const tmp = finalPath + '.tmp';
    if (!hWrite(tmp, json)) return false;
    try { JSON.parse(hRead(tmp)); } catch (e) { return false; }   // validate temp
    try {
        fs.renameSync(tmp, finalPath);
    } catch (e) {
        if (!hWrite(finalPath, json)) return false;
        try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    }
    return true;
}

/* ---- save -------------------------------------------------------------- */

function kitDoc(kit) {
    return JSON.parse(JSON.stringify(kit));   // plain copy; kit_model already matches the schema
}

function uniquePath(baseNoExt, ext) {
    let p = baseNoExt + ext;
    if (!hExists(p)) return p;
    for (let i = 2; i < 1000; i++) {
        p = `${baseNoExt} (${i})${ext}`;
        if (!hExists(p)) return p;
    }
    return `${baseNoExt} (${Date.now()})${ext}`;
}

/*
 * saveKit(kit, name, overwriteName) -> { ok, path, name } | { ok:false, error }
 *
 * Writes the working file and refreshes current-kit.json. Does NOT touch the
 * kit-name counter — the caller does that only on { ok:true }.
 *
 * If `overwriteName` is given and the (sanitised) new name equals it, the
 * existing `<name>.kitbuilder.json` is overwritten in place — this is how a
 * kit keeps one file across repeated saves of the same working session. A
 * changed name is a "save as": a new, non-colliding file.
 */
export function saveKit(kit, name, overwriteName) {
    const clean = sanitizeFilename(name || kit.name || 'Kit Builder');
    kit.name = clean;
    kit.modified_at = new Date().toISOString();

    const doc = kitDoc(kit);
    const bad = validateKit(doc);
    if (bad) return { ok: false, error: `invalid kit: ${bad}` };

    hMkdir(kitsDir());
    const same = overwriteName && sanitizeFilename(overwriteName) === clean;
    const filePath = same
        ? path.join(kitsDir(), `${clean}.kitbuilder.json`)
        : uniquePath(path.join(kitsDir(), clean), '.kitbuilder.json');
    if (!writeJsonAtomic(filePath, doc)) return { ok: false, error: 'write failed' };

    saveCurrentKit(kit);   // diagnostics / restore-on-relaunch

    return { ok: true, path: filePath, name: clean, overwrote: !!same };
}

/* Persist the most-recently-edited state. Called on save and on every
 * kit-changing action so an unsaved session survives a nodeServer restart. */
export function saveCurrentKit(kit) {
    try {
        hMkdir(KB_DIR);
        return writeJsonAtomic(currentKitPath(), kitDoc(kit));
    } catch (e) { return false; }
}

export function loadCurrentKit() {
    return loadKit(currentKitPath());
}

/* ---- reject / favourite memory ----------------------------------------
 * Library-wide, not per-kit: a sample rejected here is skipped by every
 * future Assign / re-roll; a favourite is weighted up. Stored as two flat
 * lists of filesystem paths so the engine can use them as Sets directly. */

export function loadPrefs() {
    try {
        const raw = hRead(prefsPath());
        if (raw) {
            const p = JSON.parse(raw);
            return {
                rejects: new Set(Array.isArray(p.rejects) ? p.rejects : []),
                favourites: new Set(Array.isArray(p.favourites) ? p.favourites : [])
            };
        }
    } catch (e) {
        console.log('force-kit-builder: preferences.json unreadable, starting empty (' + e + ')');
    }
    return { rejects: new Set(), favourites: new Set() };
}

export function savePrefs(rejects, favourites) {
    try {
        hMkdir(KB_DIR);
        return writeJsonAtomic(prefsPath(), {
            schema_version: 1,
            rejects: Array.from(rejects || []),
            favourites: Array.from(favourites || [])
        });
    } catch (e) { return false; }
}

/* ---- MPC .xpm export ---------------------------------------------------
 *
 * Real frame count for a pad's source WAV, for the .xpm's Layer-1 SliceEnd —
 * SliceStart 0 + SliceEnd 0 is a zero-length region (confirmed silent on a
 * real Akai Force). Node's fs.readFileSync gives raw bytes directly — no
 * base64/UTF-8 round-trip hazard here (see module doc). null (not 0) on
 * anything unreadable/not a WAV we understand, so the caller can tell
 * "empty" from "couldn't measure". */
function sampleFrameCount(p) {
    try { return wavFrameCount(fs.readFileSync(p)); } catch (e) { return null; }
}

/*
 * exportMpcXpm(kit, name, destDir) -> { ok, path, dir, warnings, errors, padCount, gathered }
 * Writes <destDir>/<Kit>/<Kit>.xpm + MANIFEST.txt and gathers each sample
 * beside the .xpm (fs.copyFileSync). Any copy that fails is tagged [MISSING]
 * in MANIFEST.txt for a manual step. `destDir` is REQUIRED and always
 * user-supplied (from the web UI's destination-folder picker) — see the
 * module doc for why there's no hardcoded Force default here yet.
 */
export function exportMpcXpm(kit, name, destDir) {
    if (!destDir) return { ok: false, errors: ['no destination folder selected'], warnings: [] };
    hMkdir(destDir);
    return buildAndWriteXpm(kit, {
        dir: destDir,
        name: name || kit.name || 'Kit Builder',
        mkdir: (p) => hMkdir(p),
        write: (p, s) => hWrite(p, s),
        copy: (src, dest) => { try { fs.copyFileSync(src, dest); return true; } catch (e) { return false; } },
        frameCount: (p) => sampleFrameCount(p)
    });
}

/* ---- load + validate ---------------------------------------------------- */

export function loadKitFromString(str) {
    let doc;
    try { doc = JSON.parse(str); } catch (e) { return { ok: false, error: `parse: ${e}` }; }
    const bad = validateKit(doc);
    if (bad) return { ok: false, error: `invalid: ${bad}` };
    return { ok: true, kit: doc };
}

export function loadKit(p) {
    if (!hExists(p)) return { ok: false, error: 'not found' };
    const raw = hRead(p);
    if (raw == null) return { ok: false, error: 'unreadable' };
    return loadKitFromString(raw);
}

/*
 * Flag pads whose sample file has gone missing WITHOUT dropping them.
 * `existsFn(path) -> bool` defaults to the host check. Returns the count of
 * missing samples.
 */
export function markMissingSamples(kit, existsFn) {
    const check = (typeof existsFn === 'function') ? existsFn : hExists;
    let missing = 0;
    for (const p of kit.pads) {
        if (p.sample && p.sample.filesystem_path) {
            const gone = !check(p.sample.filesystem_path);
            p.sample.missing = gone;
            if (gone) missing++;
        }
    }
    return missing;
}
