/*
 * Tiny assertion helpers shared by every test_*.js file.
 *
 * Split out from run.js (schwung-kit-builder's original test harness put
 * these directly in run.js and every test file imported them from there).
 * That created a circular import — run.js uses a top-level `await import()`
 * to load each test file, and each test file statically imported `assert`/
 * `eq` back from run.js — which deadlocks on Node 20 as an "unsettled
 * top-level await" (process exit code 13, no output at all, no error
 * message: the module graph just never resolves). Keeping these in their
 * own dependency-free file avoids the cycle entirely.
 */
export function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}
export function eq(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error((msg || 'not equal') + `\n  expected ${sb}\n  got      ${sa}`);
}
