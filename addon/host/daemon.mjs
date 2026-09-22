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
 *
 * Protocol keys are per-pad-indexed (pad_info_0..15, pad_lock_0..15,
 * reroll_pad_0..15, clear_pad_0..15, pad_path_0..15) rather than a shared
 * pad_sel + pad_info/pad_lock triple - each of the 16 pads has its own
 * LOCK/REROLL/CLEAR controls directly on the shadow page now (see
 * shadow_page.conf's header comment for why), so there's no single
 * "currently selected pad" concept left to track.
 *
 * SET play_pad_N is a relay, not a local action: shadow_page.conf only
 * has one ctrl_sock per page, so the PLAY button's SET arrives here like
 * everything else, and this process forwards "PLAY <N>" to
 * addon/host/preview_host's own small listen socket (a separate,
 * Modules-Manager-gated process - see DESIGN.md's v3 section for why the
 * audio ring can't live in this always-on daemon). If preview_host isn't
 * running yet, this fails gracefully (ERR, not a crash) - it's an
 * optional companion process, not a hard dependency of the core daemon.
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const SOCK_PATH = '/tmp/kitbuilder_ctrl.sock';
const PREVIEW_SOCK_PATH = '/tmp/kitbuilder_preview_ctrl.sock';

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
const loudness = await import(u('core/loudness.mjs'));
const wavRms = await import(u('core/wav_rms.mjs'));

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

/* force-shadow's baked font (src/font8x8.h) only has glyphs for space,
 * A-Z (uppercase only), 0-9, and ". - / > % + :" - anything else silently
 * renders as a blank gap, not an error (see mockbamod-module-creator
 * skill's shadow-gui.md, "Font constraint that matters more under this
 * theme, not less" - this bit force-webstream's first results page the
 * same way). Every string sent to the control socket goes through this
 * first. Disallowed characters become a space (not stripped) so words
 * don't silently run together. */
function shadowFontSafe(s) {
    if (!s) return '';
    return String(s).toUpperCase().replace(/[^A-Z0-9 .\-/>%+:]/g, ' ').replace(/\s+/g, ' ').trim();
}

function padInfoText(i) {
    const p = state.kit.pads[i];
    if (!p) return '';
    /* Pad number prefixed unconditionally, not just when there's no frame
     * title to show it otherwise - keeps this function layout-agnostic
     * (the 16-pads-one-tab layout has no per-pad frame/title at all, see
     * DESIGN.md). Redundant-but-harmless alongside a frame's own "PAD N"
     * title in the two-tab layout. */
    if (!p.sample) return shadowFontSafe(`${i + 1}: EMPTY - ${p.role}`);
    const lock = p.locked ? ' - LOCKED' : '';
    return shadowFontSafe(`${i + 1}: ${p.sample.filename} - ${p.sample.category}${lock}`);
}

/* ---- SET/GET handlers ---------------------------------------------------
 *
 * v1's protocol had one shared pad_sel/pad_info/pad_lock triple driving a
 * tap-to-select list widget. The per-pad-widget redesign (each of the 16
 * pads carries its own LOCK/REROLL/CLEAR directly - see shadow_page.conf's
 * header comment) replaced that with per-pad-indexed keys instead: no
 * selection state to track, each widget just names its own pad index. */

const PAD_KEY_RE = /^(pad_info|pad_lock|pad_path|reroll_pad|clear_pad)_(\d+)$/;

function doGet(key) {
    const m = key.match(PAD_KEY_RE);
    if (m) {
        syncKit();
        const kind = m[1];
        const i = parseInt(m[2], 10);
        if (i < 0 || i > 15) return '';
        const p = state.kit.pads[i];
        if (kind === 'pad_info') return padInfoText(i);
        if (kind === 'pad_lock') return p && p.locked ? '1' : '0';
        if (kind === 'pad_path') return (p && p.sample && p.sample.filesystem_path) || '';
        return '';
    }
    if (key === 'status') return shadowFontSafe(state.status);
    return '';
}

function rerollOnePad(i) {
    if (!state.index) { state.status = 'No sample index yet - rescan from the web UI first.'; return { ok: false, msg: state.status }; }
    const cfg = sampleIndex.loadConfig();
    const r = randomAssign.rerollPad({
        kit: state.kit, index: state.index, config: cfg,
        source: 'all', preventDuplicates: true,
        padIndex: i, rejects: state.rejects, favourites: state.favourites
    });
    if (r.changed) {
        state.kit.pads[i] = r.pad;
        state.kit.modified_at = new Date().toISOString();
        persistKit();
        state.status = `Pad ${i + 1} reassigned.`;
    } else {
        /* changed:false with no warning means core/random_assign.mjs's
         * reroll landed back on the exact sample the pad already had (a
         * real, expected outcome with a small candidate pool, confirmed
         * live in offline testing - not a locked-pad case, which has its
         * own explicit 'pad is locked' warning text already). Reply OK,
         * not ERR either way - none of these are a real failure. */
        state.status = r.warning || `Pad ${i + 1} unchanged - same sample re-picked.`;
    }
    return { ok: true, msg: state.status };
}

function doSet(key, value) {
    const m = key.match(PAD_KEY_RE);
    if (m) {
        syncKit();
        const kind = m[1];
        const i = parseInt(m[2], 10);
        if (i < 0 || i > 15) return { ok: false, msg: 'bad pad index' };
        if (kind === 'pad_lock') {
            kitModel.toggleLock(state.kit, i);
            persistKit();
            return { ok: true, msg: '' };
        }
        if (kind === 'reroll_pad') return rerollOnePad(i);
        if (kind === 'clear_pad') {
            const r = kitModel.clearPad(state.kit, i);
            if (r === 'cleared') persistKit();
            state.status = `Pad ${i + 1}: ${r}.`;
            return { ok: true, msg: state.status };
        }
        return { ok: false, msg: 'read-only key: ' + key };
    }

    syncKit();
    switch (key) {
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
        case 'clear_all': {
            const n = kitModel.clearUnlocked(state.kit);
            if (n) persistKit();
            state.status = `Cleared ${n} pad(s).`;
            return { ok: true, msg: state.status };
        }
        case 'normalize': {
            const loudnesses = state.kit.pads.map((p) => {
                if (!p.sample || !p.sample.filesystem_path) return 0;
                try {
                    const bytes = fs.readFileSync(p.sample.filesystem_path);
                    return wavRms.wavRms(bytes) || 0;
                } catch (e) { return 0; }
            });
            const gains = loudness.matchGains(loudnesses);
            for (let i = 0; i < 16; i++) kitModel.setPadGain(state.kit, i, gains[i]);
            persistKit();
            state.status = 'Levels normalised.';
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

const PLAY_PAD_RE = /^play_pad_(\d+)$/;

/* Relays "PLAY <padIndex>" to preview_host's own listen socket and calls
 * back with the same {ok,msg} shape doSet() uses. A short-lived connection
 * per tap, same reasoning as preview_host's own ctrl_get_pad_path() - tap
 * rate is nowhere near hot enough for connection setup to matter. Fails
 * gracefully (ok:false) rather than throwing if preview_host isn't running
 * (ECONNREFUSED) or hangs (safety timeout) - a PLAY tap should never be
 * able to wedge the daemon's own socket loop. */
function relayPlayPad(padIndex, cb) {
    let done = false;
    const finish = (r) => { if (!done) { done = true; cb(r); } };

    const conn = net.createConnection(PREVIEW_SOCK_PATH);
    let buf = '';
    const timer = setTimeout(() => {
        try { conn.destroy(); } catch (e) { /* already closed */ }
        finish({ ok: false, msg: 'preview timed out' });
    }, 2000);

    conn.on('connect', () => conn.write(`PLAY ${padIndex}\n`));
    conn.on('data', (d) => { buf += d.toString('utf8'); });
    conn.on('end', () => {
        clearTimeout(timer);
        const line = buf.trim();
        if (line.startsWith('OK')) finish({ ok: true, msg: '' });
        else finish({ ok: false, msg: line.replace(/^ERR\s*/, '') || 'preview failed' });
    });
    conn.on('error', (e) => {
        clearTimeout(timer);
        finish({ ok: false, msg: 'preview not running (' + e.code + ')' });
    });
}

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
        const key = (sp2 === -1 ? rest : rest.slice(0, sp2)).trim();
        const value = sp2 === -1 ? '' : rest.slice(sp2 + 1);

        const playMatch = key.match(PLAY_PAD_RE);
        if (playMatch) {
            relayPlayPad(parseInt(playMatch[1], 10), (r) => {
                sock.write((r.ok ? 'OK ' : 'ERR ') + (r.msg || '') + '\n');
            });
            return;
        }

        try {
            const r = doSet(key, value);
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
