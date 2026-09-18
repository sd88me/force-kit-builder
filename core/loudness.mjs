/*
 * Force Kit Builder — automatic loudness matching.
 *
 * Ported unchanged (verbatim math) from schwung-kit-builder's
 * src/core/loudness.mjs. On Move, the per-pad RMS readings came from the
 * native DSP (`get_param("loudness")`); here they come from wav_rms.mjs
 * reading each pad's own WAV file directly (see that module's doc) — the
 * matching math itself doesn't care where the numbers came from.
 *
 * Pure module — the caller applies the returned gains to the kit model.
 */

const EPS = 1e-5;

/* Parse a "loudness" string ("0.1832 0.2010 0.0000 ...") to 16 floats. Kept
 * for parity/tests; the Force server calls matchGains() directly with an
 * array from wav_rms.mjs rather than a space-separated string. */
export function parseLoudness(s) {
    const out = new Array(16).fill(0);
    const parts = String(s == null ? '' : s).trim().split(/\s+/);
    for (let i = 0; i < 16; i++) {
        const v = parseFloat(parts[i]);
        out[i] = (isFinite(v) && v > 0) ? v : 0;
    }
    return out;
}

/*
 * matchGains(loudnesses, opts) -> number[16]
 *   loudnesses  array of RMS fractions (0..1); 0 (or missing) = slot left at
 *               gain 1.0
 *
 * Default is ATTENUATE-ONLY: the target is a low percentile of the readings,
 * so the quietest pads keep unity gain and everything louder is turned DOWN
 * to meet them. Nothing is boosted, so the match can never add clipping.
 * Override with opts:
 *   opts.percentile  target = this fraction into the sorted readings (def 0.25)
 *   opts.target      explicit target level (overrides percentile)
 *   opts.minGain     floor,   default 0.15  (just "don't mute it")
 *   opts.maxGain     ceiling, default 1.0   (set > 1 to allow makeup boost)
 * Gains are rounded to 1e-3.
 */
export function matchGains(loudnesses, opts) {
    opts = opts || {};
    const lo = (Array.isArray(loudnesses) ? loudnesses : []).slice(0, 16);
    while (lo.length < 16) lo.push(0);

    const nz = lo.filter((x) => Number(x) > EPS).map(Number).sort((a, b) => a - b);
    if (!nz.length) return lo.map(() => 1.0);

    let target;
    if (opts.target != null) {
        target = Number(opts.target);
    } else {
        const pct = opts.percentile != null ? Number(opts.percentile) : 0.25;
        const idx = Math.max(0, Math.min(nz.length - 1, Math.floor(pct * nz.length)));
        target = nz[idx];
    }
    const minG = opts.minGain != null ? Number(opts.minGain) : 0.15;
    const maxG = opts.maxGain != null ? Number(opts.maxGain) : 1.0;

    return lo.map((x) => {
        const v = Number(x);
        if (!(v > EPS)) return 1.0;
        let g = target / v;
        if (g < minG) g = minG; else if (g > maxG) g = maxG;
        return Math.round(g * 1000) / 1000;
    });
}
