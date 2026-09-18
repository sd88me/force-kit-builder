/*
 * Force Kit Builder — nodeServer endpoint.
 *
 * Follows the exact routing convention used by nodeServer's own endpoints
 * (see file-browser/index.js and app-template/index.js): `INIT($req, $res,
 * NS)` switches on `URL[2]` (the path segment after `/kit-builder/`), pages
 * are rendered via static.HEAD()/MENU()/INCLUDE()/CLOSE(), and JSON actions
 * read a POST body via REQ.on('data'/'end') and reply with endJSON().
 *
 * This file is plain CommonJS (nodeServer's own convention — `module.exports
 * = { INIT }`), but the actual kit-building logic lives in the ES modules
 * under ../../../kitbuilder-core/ (copied there by install.sh, alongside
 * this endpoint, from this repo's core/ and exporters/ directories). CommonJS
 * can only reach ESM via dynamic `import()`, so every module is loaded once,
 * lazily, on the first request (see ensureCore()) and cached from then on.
 *
 * State model: one in-memory "current kit" + sample index + prefs, mutated
 * by each action and persisted to disk after every change (so a nodeServer
 * restart resumes where you left off) — the same working-file model
 * schwung-kit-builder used on Move, just backed by plain fs here instead of
 * QuickJS host_* shims. See DESIGN.md's "API" section for the full action
 * list and request/response shapes.
 */

module.exports = { INIT };

const fs = require('fs');
const path = require('path');
const static = require('../static.js');

let RES = null;
let REQ = null;
let URL = null;

/* ---- lazy ESM bridge ---------------------------------------------------- */

const CORE_DIR = path.join(__dirname, '..', '..', '..', 'kitbuilder-core');
let core = null;
let coreLoading = null;

function ensureCore() {
    if (core) return Promise.resolve(core);
    if (coreLoading) return coreLoading;
    coreLoading = (async () => {
        const u = (p) => require('url').pathToFileURL(path.join(CORE_DIR, p)).href;
        const kitModel = await import(u('core/kit_model.mjs'));
        const sampleClassifier = await import(u('core/sample_classifier.mjs'));
        const scanFilters = await import(u('core/scan_filters.mjs'));
        const sampleIndex = await import(u('core/sample_index.mjs'));
        const randomAssign = await import(u('core/random_assign.mjs'));
        const storage = await import(u('core/storage.mjs'));
        const loudness = await import(u('core/loudness.mjs'));
        const wavRms = await import(u('core/wav_rms.mjs'));
        const mpcXpm = await import(u('exporters/mpc_xpm.mjs'));

        sampleIndex.configureDataDir(path.join(CORE_DIR, 'data'));

        core = { kitModel, sampleClassifier, scanFilters, sampleIndex, randomAssign, storage, loudness, wavRms, mpcXpm };

        /* Load persisted state once, at first use. */
        const cur = storage.loadCurrentKit();
        state.kit = cur.ok ? cur.kit : kitModel.createKit(sampleIndex.loadConfig());
        state.index = sampleIndex.loadIndex();
        const prefs = storage.loadPrefs();
        state.rejects = prefs.rejects;
        state.favourites = prefs.favourites;
        return core;
    })();
    return coreLoading;
}

/* In-memory working state, persisted to disk on every mutation. */
const state = {
    kit: null,
    index: null,
    rejects: new Set(),
    favourites: new Set()
};

/* ---- request plumbing (mirrors file-browser/index.js's own pattern) ---- */

function endJSON(obj, code) {
    RES.writeHead(code || 200, { 'Content-Type': 'text/json' });
    RES.end(JSON.stringify(obj));
}

function errorJSON(message, code) {
    endJSON({ ok: false, error: message }, code || 400);
}

function readBody() {
    return new Promise((resolve, reject) => {
        let body = '';
        REQ.on('data', (chunk) => { body += chunk.toString(); });
        REQ.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        REQ.on('error', reject);
    });
}

async function withBody(handler) {
    let payload;
    try { payload = await readBody(); } catch (e) { return errorJSON('invalid JSON body'); }
    try {
        await handler(payload);
    } catch (e) {
        console.log('force-kit-builder: ' + (e && e.stack || e));
        errorJSON(String((e && e.message) || e), 500);
    }
}

/* ---- page shell ---------------------------------------------------------- */

function LIST() {
    RES.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const css = ['/kit-builder/style.css'];
    const js = ['/kit-builder/client.js|defer'];
    static.HEAD(RES, 'Force Kit Builder', css, js);
    RES.write('<body>');
    static.MENU(REQ, RES);
    static.INCLUDE(RES, path.join(__dirname, 'template.html'));
    static.CLOSE(RES);
    RES.end();
}

/* Static asset passthrough for this endpoint's own client.js/style.css —
 * nodeServer's static.js only serves out of client/, and this plugin
 * deliberately keeps its assets next to its own endpoint code instead (see
 * DESIGN.md), so it serves them itself for the two files it has. */
function ASSET(name, contentType) {
    const p = path.join(__dirname, name);
    fs.readFile(p, (err, data) => {
        if (err) { RES.writeHead(404, { 'Content-Type': 'text/plain' }); RES.end('not found'); return; }
        RES.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
        RES.end(data);
    });
}

/* ---- state / status ------------------------------------------------------ */

function summaryOf(c) {
    if (!state.index) return { indexed: 0, kick: 0, snare: 0, clap: 0, hats: 0, toms: 0, perc: 0, cym: 0, fx: 0, other: 0, byRoot: {} };
    return c.sampleIndex.summarizeRecords(state.index.records, 'all');
}

async function STATE() {
    const c = await ensureCore();
    const cfg = c.sampleIndex.loadConfig();
    endJSON({
        ok: true,
        kit: state.kit,
        config: { sample_roots: cfg.sample_roots, scan_filters: cfg.scan_filters, pad_layout: cfg.pad_layout },
        categories: c.sampleIndex.ROLE_ORDER,
        index: {
            present: !!state.index,
            generated_at: state.index ? state.index.generated_at : null,
            count: state.index ? state.index.count : 0,
            skipped_loops: state.index ? state.index.skipped_loops : 0,
            skipped_oversize: state.index ? state.index.skipped_oversize : 0,
            summary: summaryOf(c)
        },
        rejects: Array.from(state.rejects),
        favourites: Array.from(state.favourites)
    });
}

/* ---- sample roots / rescan ------------------------------------------------ */

async function SET_ROOTS() {
    const c = await ensureCore();
    await withBody(async (body) => {
        const roots = Array.isArray(body.roots) ? body.roots.filter((r) => typeof r === 'string' && r) : [];
        c.storage.saveSampleRoots(roots);
        endJSON({ ok: true, roots });
    });
}

async function RESCAN() {
    const c = await ensureCore();
    await withBody(async (body) => {
        if (body.scan_filters) c.storage.saveScanPrefs(body.scan_filters);
        const cfg = c.sampleIndex.loadConfig();
        if (!cfg.sample_roots || !cfg.sample_roots.length) {
            return errorJSON('no sample root folders selected');
        }
        const scan = c.sampleIndex.createScan(cfg);
        let phase = scan.state.phase;
        while (phase === 'scanning') phase = scan.step(2000);
        if (phase === 'error') return errorJSON('scan failed: ' + scan.state.error);
        state.index = c.sampleIndex.loadIndex();
        c.storage.markMissingSamples(state.kit, undefined);
        c.storage.saveCurrentKit(state.kit);
        endJSON({ ok: true, kit: state.kit, index: { count: state.index.count, summary: summaryOf(c) } });
    });
}

/* ---- kit mutation actions -------------------------------------------------- */

function persist(c) { c.storage.saveCurrentKit(state.kit); }

async function ASSIGN() {
    const c = await ensureCore();
    await withBody(async (body) => {
        if (!state.index) return errorJSON('no sample index yet — rescan first');
        const cfg = c.sampleIndex.loadConfig();
        const r = c.randomAssign.assignKit({
            kit: state.kit, index: state.index, config: cfg,
            seed: body.seed, source: body.source || 'all',
            preventDuplicates: body.preventDuplicates !== false,
            rejects: state.rejects, favourites: state.favourites
        });
        state.kit.pads = r.pads;
        state.kit.random_seed = r.seed;
        state.kit.modified_at = new Date().toISOString();
        persist(c);
        endJSON({ ok: true, kit: state.kit, warning: r.warning, unresolved: r.unresolved, relaxed: r.relaxed });
    });
}

async function REROLL() {
    const c = await ensureCore();
    await withBody(async (body) => {
        if (!state.index) return errorJSON('no sample index yet — rescan first');
        const cfg = c.sampleIndex.loadConfig();
        const padIndex = body.padIndex | 0;
        const r = c.randomAssign.rerollPad({
            kit: state.kit, index: state.index, config: cfg,
            seed: body.seed, source: body.source || 'all',
            preventDuplicates: body.preventDuplicates !== false,
            padIndex, rejects: state.rejects, favourites: state.favourites
        });
        if (r.changed) {
            state.kit.pads[padIndex] = r.pad;
            state.kit.modified_at = new Date().toISOString();
            persist(c);
        }
        endJSON({ ok: true, kit: state.kit, changed: r.changed, warning: r.warning });
    });
}

async function SET_PAD() {
    const c = await ensureCore();
    await withBody(async (body) => {
        const i = body.padIndex | 0;
        if (i < 0 || i > 15) return errorJSON('padIndex out of range');
        switch (body.action) {
            case 'toggle_lock': c.kitModel.toggleLock(state.kit, i); break;
            case 'clear': c.kitModel.clearPad(state.kit, i); break;
            case 'gain': c.kitModel.setPadGain(state.kit, i, body.value); break;
            default: return errorJSON('unknown action: ' + body.action);
        }
        persist(c);
        endJSON({ ok: true, kit: state.kit });
    });
}

async function SET_POOL() {
    const c = await ensureCore();
    await withBody(async (body) => {
        const i = body.padIndex | 0;
        if (i < 0 || i > 15) return errorJSON('padIndex out of range');
        const categories = Array.isArray(body.categories) ? body.categories : (body.category ? [body.category] : null);
        if (!categories || !categories.length) return errorJSON('categories (or category) required');
        const layout = c.storage.savePadLayoutEntry(i, categories);
        if (!layout) return errorJSON('write failed', 500);
        endJSON({ ok: true, pad_layout: layout });
    });
}

async function CLEAR_ALL() {
    const c = await ensureCore();
    c.kitModel.clearUnlocked(state.kit);
    persist(c);
    endJSON({ ok: true, kit: state.kit });
}

async function UNLOCK_ALL() {
    const c = await ensureCore();
    c.kitModel.unlockAll(state.kit);
    persist(c);
    endJSON({ ok: true, kit: state.kit });
}

async function NEW_KIT() {
    const c = await ensureCore();
    state.kit = c.kitModel.createKit(c.sampleIndex.loadConfig());
    persist(c);
    endJSON({ ok: true, kit: state.kit });
}

/* ---- favourite / reject (library-wide) ------------------------------------ */

async function FAVREJECT() {
    const c = await ensureCore();
    await withBody(async (body) => {
        const p = body.path;
        if (typeof p !== 'string' || !p) return errorJSON('path required');
        if (body.action === 'favourite') { state.favourites.add(p); state.rejects.delete(p); }
        else if (body.action === 'reject') { state.rejects.add(p); state.favourites.delete(p); }
        else if (body.action === 'clear') { state.favourites.delete(p); state.rejects.delete(p); }
        else if (body.action === 'clear_all_favourites') state.favourites.clear();
        else if (body.action === 'clear_all_rejects') state.rejects.clear();
        else return errorJSON('unknown action: ' + body.action);
        c.storage.savePrefs(state.rejects, state.favourites);
        endJSON({ ok: true, rejects: Array.from(state.rejects), favourites: Array.from(state.favourites) });
    });
}

/* ---- loudness matching ----------------------------------------------------- */

async function MATCH_LEVELS() {
    const c = await ensureCore();
    const loudnesses = state.kit.pads.map((p) => {
        if (!p.sample || !p.sample.filesystem_path) return 0;
        try {
            const bytes = fs.readFileSync(p.sample.filesystem_path);
            return c.wavRms.wavRms(bytes) || 0;
        } catch (e) { return 0; }
    });
    const gains = c.loudness.matchGains(loudnesses);
    for (let i = 0; i < 16; i++) c.kitModel.setPadGain(state.kit, i, gains[i]);
    persist(c);
    endJSON({ ok: true, kit: state.kit, gains });
}

/* ---- load an existing .xpm --------------------------------------------------
 *
 * See exporters/mpc_xpm.mjs's parseXpm() doc for the v1 "Instrument N = pad N"
 * limitation. Samples are resolved case-insensitively next to the .xpm (the
 * MPC's own convention — SampleName has no extension, so every supported
 * extension is tried); anything not found is reported as a warning rather
 * than failing the whole import. Replaces the whole working kit, same as
 * NEW_KIT — this is a "start editing this kit" action, not a merge.
 */
async function IMPORT_XPM() {
    const c = await ensureCore();
    await withBody(async (body) => {
        const xpmPath = body.path;
        if (typeof xpmPath !== 'string' || !xpmPath) return errorJSON('path required');

        let text;
        try { text = fs.readFileSync(xpmPath, 'utf8'); } catch (e) { return errorJSON('could not read file: ' + (e.message || e)); }

        const parsed = c.mpcXpm.parseXpm(text);
        const dir = path.dirname(xpmPath);
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch (e) { /* directory listing best-effort */ }
        const byLower = new Map();
        for (const f of entries) byLower.set(f.toLowerCase(), f);

        const cfg = c.sampleIndex.loadConfig();
        const aliasIndex = c.sampleClassifier.buildAliasIndex(cfg.role_rules);
        const kit = c.kitModel.createKit(cfg);
        kit.name = parsed.name || path.basename(xpmPath).replace(/\.xpm$/i, '');

        const warnings = [];
        const exts = ['.wav', '.WAV', '.aif', '.AIF', '.aiff', '.AIFF'];
        let imported = 0;
        for (let i = 0; i < 16; i++) {
            const p = parsed.pads[i];
            if (!p || !p.sampleName) continue;
            let foundFile = null;
            for (const ext of exts) {
                const cand = byLower.get((p.sampleName + ext).toLowerCase());
                if (cand) { foundFile = cand; break; }
            }
            if (!foundFile) { warnings.push(`pad ${i + 1}: sample "${p.sampleName}" not found next to the .xpm`); continue; }
            const fullPath = path.join(dir, foundFile);
            kit.pads[i].sample = {
                filesystem_path: fullPath,
                source: dir,
                filename: foundFile,
                category: c.sampleClassifier.classifyFilename(foundFile, aliasIndex)
            };
            imported++;
        }

        state.kit = kit;
        persist(c);
        endJSON({ ok: true, kit: state.kit, imported, warnings });
    });
}

/* ---- save / export --------------------------------------------------------- */

async function SAVE() {
    const c = await ensureCore();
    await withBody(async (body) => {
        const r = c.storage.saveKit(state.kit, body.name, body.overwriteName);
        if (!r.ok) return errorJSON(r.error);
        endJSON({ ok: true, path: r.path, name: r.name, kit: state.kit });
    });
}

async function EXPORT() {
    const c = await ensureCore();
    await withBody(async (body) => {
        if (!body.destDir) return errorJSON('destDir required — pick a destination folder first');
        const r = c.storage.exportMpcXpm(state.kit, body.name, body.destDir);
        endJSON({ ok: r.ok, path: r.path, dir: r.dir, warnings: r.warnings, errors: r.errors, padCount: r.padCount, gathered: r.gathered });
    });
}

/* ---- audition streaming ----------------------------------------------------
 *
 * The path is a URL segment (`/kit-builder/AUDIO/<encodeURIComponent(path)>`),
 * matching nodeServer's own file-browser READ/DOWNLOAD convention — NOT a
 * `?path=` query string, which the URL[2] router (see INIT()) can't match
 * against a plain switch/case since the query string rides along with the
 * segment. Only ever streams a path that's either the current kit's own pad
 * sample or a record in the loaded sample index — never an arbitrary path —
 * so this can't be used as an arbitrary-file-read primitive even though it's
 * an unauthenticated local endpoint (same trust model as the rest of
 * nodeServer, but this file doesn't widen it). */
function knownPaths(c) {
    const known = new Set();
    for (const p of state.kit.pads) if (p.sample && p.sample.filesystem_path) known.add(p.sample.filesystem_path);
    if (state.index) for (const rec of state.index.records) known.add(rec.filesystem_path);
    return known;
}

async function AUDIO() {
    const c = await ensureCore();
    const p = decodeURIComponent(URL.slice(3).join('/'));
    if (!p || !knownPaths(c).has(p)) {
        RES.writeHead(404, { 'Content-Type': 'text/plain' });
        RES.end('unknown sample path');
        return;
    }
    fs.readFile(p, (err, data) => {
        if (err) { RES.writeHead(404, { 'Content-Type': 'text/plain' }); RES.end('read failed'); return; }
        const ext = path.extname(p).toLowerCase();
        const mime = ext === '.aif' || ext === '.aiff' ? 'audio/aiff' : 'audio/wav';
        RES.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
        RES.end(data);
    });
}

/* ---- router ---------------------------------------------------------------- */

function INIT($req, $res) {
    RES = $res;
    REQ = $req;
    URL = $req.url.replace('/^\//', '').split('/');

    switch (URL[2]) {
        case '': case undefined: case '/': LIST(); break;
        case 'client.js': ASSET('client.js', 'text/javascript'); break;
        case 'style.css': ASSET('style.css', 'text/css'); break;
        case 'STATE': STATE().catch(fail); break;
        case 'SET_ROOTS': SET_ROOTS().catch(fail); break;
        case 'RESCAN': RESCAN().catch(fail); break;
        case 'ASSIGN': ASSIGN().catch(fail); break;
        case 'REROLL': REROLL().catch(fail); break;
        case 'SET_PAD': SET_PAD().catch(fail); break;
        case 'SET_POOL': SET_POOL().catch(fail); break;
        case 'CLEAR_ALL': CLEAR_ALL().catch(fail); break;
        case 'UNLOCK_ALL': UNLOCK_ALL().catch(fail); break;
        case 'NEW_KIT': NEW_KIT().catch(fail); break;
        case 'IMPORT_XPM': IMPORT_XPM().catch(fail); break;
        case 'FAVREJECT': FAVREJECT().catch(fail); break;
        case 'MATCH_LEVELS': MATCH_LEVELS().catch(fail); break;
        case 'SAVE': SAVE().catch(fail); break;
        case 'EXPORT': EXPORT().catch(fail); break;
        case 'AUDIO': AUDIO().catch(fail); break;
        default:
            RES.writeHead(404, { 'Content-Type': 'text/plain' });
            RES.end('unknown kit-builder action: ' + URL[2]);
    }
}

function fail(e) {
    console.log('force-kit-builder: ' + (e && e.stack || e));
    try { errorJSON(String((e && e.message) || e), 500); } catch (e2) { /* response already sent */ }
}
