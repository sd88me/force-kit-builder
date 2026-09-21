/*
 * Force Kit Builder — shadow-GUI control-socket daemon.
 *
 * Bridges force-shadow's page (see ../shadow_page.conf) to Kit Builder's
 * core logic. Speaks the same plain-text SET/GET protocol every other
 * shadow-GUI-backed addon uses (confirmed identical across the family —
 * see force-shadow/docs/adding-a-page.md):
 *
 *   SET <key> <value>\n   ->  OK <text>\n | ERR <text>\n
 *   GET <key>\n           ->  <value>\n
 *
 * This is a thin protocol adapter, not a reimplementation - it imports
 * core/ and exporters/ from nodeServer's own already-installed
 * kitbuilder-core/ directly (not a private copy), so it is automatically
 * looking at the exact same current-kit.json/preferences.json the
 * nodeServer web plugin reads and writes. See DESIGN.md's v2 scoping
 * section ("Key finding: they already share state for free") for why this
 * is deliberate, not an oversight - there is exactly one copy of core/ on
 * disk, imported by two front ends.
 *
 * No engine_process_name block in shadow_page.conf -> no on/off button,
 * no Modules Manager entry, no NSMODULE.json - this process just runs in
 * the background from boot like a sequencer addon (see manage.sh), idle
 * until a SET/GET line arrives.
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const SOCK_PATH = '/tmp/kitbuilder_ctrl.sock';

function resolveNodeServerAppDir() {
    // Same convention every addon uses to find its install root - see
    // mockbamod-module-creator skill's references/architecture.md.
    const mmPath = fs.readFileSync('/dev/shm/.mmPath', 'utf8').trim();
    return path.join(mmPath, 'AddOns', 'nodeServer', 'app');
}

const CORE_DIR = path.join(resolveNodeServerAppDir(), 'kitbuilder-core');

function u(rel) { return pathToFileURL(path.join(CORE_DIR, rel)).href; }

const kitModel = await import(u('core/kit_model.mjs'));
const sampleIndex = await import(u('core/sample_index.mjs'));
const randomAssign = await import(u('core/random_assign.mjs'));
const storage = await import(u('core/storage.mjs'));

/* Same data dir the nodeServer plugin points at - see plugin's index.js
 * ensureCore(), CORE_DIR is identical here since both resolve relative to
 * the one on-disk kitbuilder-core/ install. */
sampleIndex.configureDataDir(path.join(CORE_DIR, 'data'));

/* ---- in-memory state, loaded once at startup, same pattern as the
 * nodeServer plugin's ensureCore() ------------------------------------- */

const state = {
    kit: null,
    index: null,
    rejects: new Set(),
    favourites: new Set(),
    lastExportDir: '',
    padSel: 0,
    status: 'Ready.'
};

function reloadFromDisk() {
    const cur = storage.loadCurrentKit();
    state.kit = cur.ok ? cur.kit : kitModel.createKit(sampleIndex.loadConfig());
    state.index = sampleIndex.loadIndex();
    const prefs = storage.loadPrefs();
    state.rejects = prefs.rejects;
    state.favourites = prefs.favourites;
    state.lastExportDir = prefs.lastExportDir;
}
reloadFromDisk();

function persistKit() { storage.saveCurrentKit(state.kit); }

/* Re-read current-kit.json before every request. The web plugin and this
 * daemon each hold their own in-memory copy, so without this the shadow
 * page could show a stale kit after the web UI generates/edits one -
 * cheap enough (one small JSON read) that reading fresh beats trying to
 * detect staleness. index/prefs are not re-synced per request: they only
 * change via an explicit RESCAN or export-dir change from the web UI,
 * infrequent enough that startup-load is an acceptable v1 limitation. */
function syncKit() {
    const cur = storage.loadCurrentKit();
    if (cur.ok) state.kit = cur.kit;
}

/* ---- pad helpers -------------------------------------------------------- */

function padLabel(p) {
    if (!p || !p.sample) return '(empty)';
    return p.sample.filename || '(empty)';
}

function padsJson() {
    return JSON.stringify(state.kit.pads.map((p) => ({
        label: padLabel(p),
        name: p.role || ''
    })));
}

function padInfoText() {
    const p = state.kit.pads[state.padSel];
    if (!p) return '';
    if (!p.sample) return `Pad ${state.padSel + 1}: empty (${p.role})`;
    const lock = p.locked ? ' [LOCKED]' : '';
    return `Pad ${state.padSel + 1}: ${p.sample.filename} (${p.sample.category})${lock}`;
}

/* ---- SET/GET handlers --------------------------------------------------- */

function doGet(key) {
    if (key === 'pads' || key === 'pad_info' || key === 'pad_lock') syncKit();
    switch (key) {
        case 'pads': return padsJson();
        case 'pad_sel': return String(state.padSel);
        case 'pad_info': return padInfoText();
        case 'pad_lock': {
            const p = state.kit.pads[state.padSel];
            return p && p.locked ? '1' : '0';
        }
        case 'status': return state.status;
        default: return '';
    }
}

function doSet(key, value) {
    if (key !== 'pad_sel') syncKit();
    switch (key) {
        case 'pad_sel': {
            const i = parseInt(value, 10);
            if (!Number.isInteger(i) || i < 0 || i > 15) return { ok: false, msg: 'bad pad index' };
            state.padSel = i;
            return { ok: true, msg: '' };
        }
        case 'pad_lock': {
            kitModel.toggleLock(state.kit, state.padSel);
            persistKit();
            return { ok: true, msg: '' };
        }
        case 'generate': {
            if (!state.index) { state.status = 'No sample index yet - rescan from the web UI first.'; return { ok: false, msg: state.status }; }
            const cfg = sampleIndex.loadConfig();
            const r = randomAssign.assignKit({
                kit: state.kit, index: state.index, config: cfg,
                source: 'all', preventDuplicates: true,
                rejects: state.rejects, favourites: state.favourites
            });
            state.kit.pads = r.pads;
            state.kit.random_seed = r.seed;
            state.kit.modified_at = new Date().toISOString();
            persistKit();
            state.status = r.warning ? `Generated with warning: ${r.warning}` : 'Generated a new kit.';
            return { ok: true, msg: state.status };
        }
        case 'reassign_pad': {
            if (!state.index) { state.status = 'No sample index yet - rescan from the web UI first.'; return { ok: false, msg: state.status }; }
            const cfg = sampleIndex.loadConfig();
            const r = randomAssign.rerollPad({
                kit: state.kit, index: state.index, config: cfg,
                source: 'all', preventDuplicates: true,
                padIndex: state.padSel, rejects: state.rejects, favourites: state.favourites
            });
            if (r.changed) {
                state.kit.pads[state.padSel] = r.pad;
                state.kit.modified_at = new Date().toISOString();
                persistKit();
                state.status = 'Pad reassigned.';
            } else {
                /* Locked pad, or nothing left to assign - core/random_assign.mjs
                 * returns {changed:false, warning} rather than throwing (see
                 * DESIGN.md's v2 scoping "open items"). Reply OK, not ERR - this
                 * is an expected outcome the shadow page shows via status, not a
                 * real failure. */
                state.status = r.warning || 'Pad unchanged (locked?).';
            }
            return { ok: true, msg: state.status };
        }
        case 'export': {
            if (!state.lastExportDir) {
                state.status = 'No export folder set yet - export once from the web UI first.';
                return { ok: false, msg: state.status };
            }
            const r = storage.exportMpcXpm(state.kit, undefined, state.lastExportDir);
            if (r.ok) {
                state.status = `Exported to ${r.path}`;
            } else {
                state.status = `Export failed: ${(r.errors || []).join('; ') || 'unknown error'}`;
            }
            return { ok: r.ok, msg: state.status };
        }
        default:
            return { ok: false, msg: 'unknown key: ' + key };
    }
}

/* ---- control socket ------------------------------------------------------ */

try { fs.unlinkSync(SOCK_PATH); } catch (e) { /* not present yet, fine */ }

const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            handleLine(sock, line);
        }
    });
    sock.on('error', () => {});
});

function handleLine(sock, line) {
    const sp = line.indexOf(' ');
    const cmd = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);

    if (cmd === 'GET') {
        sock.write(doGet(rest.trim()) + '\n');
        return;
    }
    if (cmd === 'SET') {
        const sp2 = rest.indexOf(' ');
        const key = sp2 === -1 ? rest : rest.slice(0, sp2);
        const value = sp2 === -1 ? '' : rest.slice(sp2 + 1);
        try {
            const r = doSet(key.trim(), value);
            sock.write((r.ok ? 'OK ' : 'ERR ') + (r.msg || '') + '\n');
        } catch (e) {
            sock.write('ERR ' + e.message + '\n');
        }
        return;
    }
    sock.write('ERR unknown command\n');
}

server.listen(SOCK_PATH, () => {
    fs.chmodSync(SOCK_PATH, 0o777);
    console.log('force-kit-builder shadow daemon listening on ' + SOCK_PATH);
});
