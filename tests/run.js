/*
 * Minimal test runner — no dependencies. `node tests/run.js`.
 * Each test file exports an array of { name, fn } or a default function that
 * throws on failure.
 *
 * `assert`/`eq` live in assert.js to break a circular-import deadlock (see
 * that file's doc).
 */
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;

const files = readdirSync(here).filter((f) => /^test_.*\.js$/.test(f));
for (const f of files) {
    const mod = await import(pathToFileURL(join(here, f)).href);
    const cases = mod.tests || (mod.default ? [{ name: f, fn: mod.default }] : []);
    for (const c of cases) {
        try {
            await c.fn();
            pass++;
            console.log(`  ok   ${f} :: ${c.name}`);
        } catch (e) {
            fail++;
            console.log(`  FAIL ${f} :: ${c.name}\n       ${String(e.message || e).replace(/\n/g, '\n       ')}`);
        }
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
