/*
 * Storage: atomic writes, kit save/load round-trip, prefs, sanitisation.
 *
 * storage.mjs talks to plain Node fs directly, so this test exercises it
 * against a real scratch directory under os.tmpdir().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, eq } from './assert.js';
import { configureDataDir } from '../core/sample_index.mjs';
import { createKit } from '../core/kit_model.mjs';
import {
    sanitizeFilename, saveKit, loadKit, kitsDir, currentKitPath,
    loadPrefs, savePrefs, generatedKitName, writeJsonAtomic
} from '../core/storage.mjs';

function withScratchDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-kit-builder-test-'));
    configureDataDir(dir);
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export const tests = [
    { name: 'sanitizeFilename strips path separators and invalid chars', fn() {
        eq(sanitizeFilename('My/Kit\\Name'), 'MyKitName');
        eq(sanitizeFilename('a..b'), 'a.b');
        eq(sanitizeFilename('bad:name*here?'), 'bad_name_here_');
        eq(sanitizeFilename('   '), 'Kit Builder');
        eq(sanitizeFilename('..'), 'Kit Builder');
    }},

    { name: 'generatedKitName formats counter and date', fn() {
        eq(generatedKitName(7, new Date('2026-09-18T00:00:00Z')), 'Kit Builder 007 2026-09-18');
    }},

    { name: 'writeJsonAtomic writes valid JSON that round-trips', fn() {
        withScratchDir((dir) => {
            const p = path.join(dir, 'x.json');
            assert(writeJsonAtomic(p, { a: 1 }));
            eq(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 });
            assert(!fs.existsSync(p + '.tmp'), 'tmp file should be gone after rename');
        });
    }},

    { name: 'saveKit writes a .kitbuilder.json file and current-kit.json', fn() {
        withScratchDir((dir) => {
            const kit = createKit();
            const r = saveKit(kit, 'My Test Kit');
            assert(r.ok, JSON.stringify(r));
            eq(r.name, 'My Test Kit');
            assert(fs.existsSync(r.path));
            assert(fs.existsSync(currentKitPath()));
            assert(r.path.startsWith(kitsDir()));

            const loaded = loadKit(r.path);
            assert(loaded.ok, JSON.stringify(loaded));
            eq(loaded.kit.name, 'My Test Kit');
            eq(loaded.kit.pads.length, 16);
        });
    }},

    { name: 'saveKit with the same name overwrites in place; a new name saves-as', fn() {
        withScratchDir(() => {
            const kit = createKit();
            const first = saveKit(kit, 'Overwrite Me');
            assert(first.ok);
            const again = saveKit(kit, 'Overwrite Me', 'Overwrite Me');
            assert(again.ok);
            eq(again.path, first.path);
            eq(again.overwrote, true);

            const renamed = saveKit(kit, 'A Different Name', 'Overwrite Me');
            assert(renamed.ok);
            assert(renamed.path !== first.path, 'a changed name should save as a new file');
        });
    }},

    { name: 'loadKit reports not found / invalid distinctly', fn() {
        withScratchDir((dir) => {
            const missing = loadKit(path.join(dir, 'nope.json'));
            eq(missing.ok, false);
            eq(missing.error, 'not found');

            const badPath = path.join(dir, 'bad.json');
            fs.writeFileSync(badPath, '{ not json');
            const bad = loadKit(badPath);
            eq(bad.ok, false);
            assert(bad.error.startsWith('parse:'));
        });
    }},

    { name: 'prefs round-trip rejects/favourites as Sets', fn() {
        withScratchDir(() => {
            const empty = loadPrefs();
            eq(empty.rejects.size, 0);
            eq(empty.favourites.size, 0);

            savePrefs(new Set(['/a.wav', '/b.wav']), new Set(['/c.wav']));
            const loaded = loadPrefs();
            eq(Array.from(loaded.rejects).sort(), ['/a.wav', '/b.wav']);
            eq(Array.from(loaded.favourites).sort(), ['/c.wav']);
            eq(loaded.lastExportDir, '');
        });
    }},

    { name: 'savePrefs persists last_export_dir, omitting extra leaves it unset', fn() {
        withScratchDir(() => {
            savePrefs(new Set(), new Set(), { last_export_dir: '/media/662522/Expansions' });
            eq(loadPrefs().lastExportDir, '/media/662522/Expansions');

            /* A call site that forgets to pass `extra` (or a caller not
             * threading it through) replaces the whole file and drops it -
             * this is the exact hazard persistPrefs() in the nodeServer
             * endpoint exists to avoid; documented here as the behaviour
             * to guard against, not a desired outcome. */
            savePrefs(new Set(), new Set());
            eq(loadPrefs().lastExportDir, '');
        });
    }}
];
