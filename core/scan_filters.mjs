/*
 * Force Kit Builder — scan-time sample filters.
 *
 * Originally adapted from github.com/klingklangmatze/drum-kit-generator.
 *
 * Two opt-in filters applied while the index is built, to avoid choking on
 * huge sample libraries:
 *   - skip_loops       drop files whose name looks like a loop
 *   - max_sample_size  drop files larger than a byte cap
 *
 * Pure module. `makeScanFilter(cfg)` reads `cfg.scan_filters`
 * ({ skip_loops, max_sample_size }) and returns a filter whose `reject(name,
 * sizeBytes)` gives `null` (keep), `'loop'`, or `'oversize'`.
 */

/* Loop heuristic: "loop" anywhere in the name, or a bracketed number
 * ("[120]", "[130bpm]", "[120 bpm]"), or an "<n> bpm" tag. */
export function looksLikeLoop(filename) {
    const n = String(filename || '').toLowerCase();
    return n.indexOf('loop') !== -1 || /\[\s*\d+/.test(n) || /\d+\s*bpm/.test(n);
}

const UNITS = { b: 1, kb: 1024, mb: 1048576, gb: 1073741824 };

/* "2mb" -> 2097152, "1.5MB" -> 1572864, 500000 -> 500000, null/""/0 -> null. */
export function parseSizeBytes(v) {
    if (v == null || v === false || v === '') return null;
    if (typeof v === 'number') return (isFinite(v) && v > 0) ? Math.floor(v) : null;
    const s = String(v).trim().toLowerCase().replace(/\s+/g, '');
    const m = s.match(/^(\d*\.?\d+)(b|kb|mb|gb)?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!(n > 0)) return null;
    return Math.floor(n * UNITS[m[2] || 'b']);
}

/* UI enum for the max-size control. */
export const SIZE_CAP_CHOICES = [null, '1mb', '2mb', '5mb', '10mb'];
export const SIZE_CAP_LABELS = ['Off', '1M', '2M', '5M', '10M'];

export function makeScanFilter(cfg) {
    const sf = (cfg && cfg.scan_filters) || {};
    const skipLoops = sf.skip_loops === undefined ? true : !!sf.skip_loops;   // default on
    const maxBytes = parseSizeBytes(sf.max_sample_size);

    return {
        skipLoops,
        maxBytes,
        reject(name, sizeBytes) {
            if (skipLoops && looksLikeLoop(name)) return 'loop';
            if (maxBytes != null && Number(sizeBytes) > maxBytes) return 'oversize';
            return null;
        }
    };
}
