/*
 * Force Kit Builder — internal kit data model.
 *
 * Ported from schwung-kit-builder's src/core/kit_model.mjs (Ableton Move).
 * Changes from the Move original: dropped `sample.ableton_uri` (no Move URI
 * scheme here) and the `source_mode`/user-core split (the Force has one
 * filesystem, not Move's User/Core library split) — `sample.source` is now
 * just a free-text label for whichever root folder the sample came from.
 *
 * Pure module: no filesystem access here at all.
 */

/* Pad 1..16 -> MIDI note 36..51. */
export const PAD_MIDI_NOTES = Array.from({ length: 16 }, (_, i) => 36 + i);

/* Each pad draws from a UNION of categories. `["other"]` is a sentinel: the
 * assignment engine expands it to every category with no dedicated pad slot,
 * plus `fx`. Used only when the config omits `pad_layout`. */
export const DEFAULT_PAD_LAYOUT = [
    ['kick'],                          // 1
    ['rim', 'snare'],                  // 2
    ['snare'],                         // 3
    ['clap', 'percussion'],            // 4
    ['percussion', 'tom', 'conga'],    // 5
    ['hat', 'closed_hat', 'open_hat'], // 6  generic hat pad (any kind)
    ['closed_hat', 'hat'],             // 7  falls back to generic hats
    ['open_hat', 'hat'],               // 8  falls back to generic hats
    ['ride', 'cymbal', 'crash'],       // 9
    ['tom', 'percussion', 'conga'],    // 10
    ['percussion'],                    // 11
    ['fx'],                            // 12
    ['other'], ['other'], ['other'], ['other']   // 13-16
];

function nowIso() { return new Date().toISOString(); }

/* Cheap UUID-ish id for diagnostics. Not crypto-grade. */
export function kitId() {
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${h()}${h()}-${h()}-4${h().slice(1)}-${((Math.random() * 4) | 8).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}

/* The category-union pool for a pad. `config` may carry an override
 * `pad_layout`; otherwise DEFAULT_PAD_LAYOUT applies. Always a non-empty array. */
export function padPool(padNum, config) {
    const layout = (config && Array.isArray(config.pad_layout)) ? config.pad_layout : DEFAULT_PAD_LAYOUT;
    const entry = layout[padNum - 1];
    return (Array.isArray(entry) && entry.length) ? entry.slice() : ['other'];
}

/* The pad's primary category — first in its pool. Stored as `pad.role` for
 * display purposes only (not authoritative for pool membership). */
export function roleForPad(padNum, config) {
    return padPool(padNum, config)[0] || 'other';
}

/* One pad object. Empty pad -> sample: null. */
export function makePad(padNum, config) {
    return {
        pad: padNum,
        midi_note: PAD_MIDI_NOTES[padNum - 1],
        role: roleForPad(padNum, config),
        locked: false,
        sample: null,
        playback: { gain: 1.0 }
    };
}

/* A fresh, empty 16-pad kit. */
export function createKit(config) {
    return {
        schema_version: 1,
        application: 'force-kit-builder',
        kit_id: kitId(),
        name: '',
        created_at: nowIso(),
        modified_at: nowIso(),
        random_seed: 0,
        prevent_duplicates: true,
        pads: Array.from({ length: 16 }, (_, i) => makePad(i + 1, config))
    };
}

/* Build the sample sub-object stored on a pad from an index record. */
export function sampleFromRecord(rec) {
    return {
        filesystem_path: rec.filesystem_path,
        source: rec.source || 'library',
        filename: rec.filename,
        category: rec.category
    };
}

export function lockedCount(kit) {
    return kit.pads.reduce((n, p) => n + (p.locked ? 1 : 0), 0);
}
export function assignedCount(kit) {
    return kit.pads.reduce((n, p) => n + (p.sample ? 1 : 0), 0);
}

/* Toggle one pad's lock. Locking an empty pad is allowed. */
export function toggleLock(kit, padIndex) {
    const p = kit.pads[padIndex];
    p.locked = !p.locked;
    kit.modified_at = nowIso();
    return p.locked;
}

/* Clear all UNLOCKED pads. Never touches audio files. Returns how many pads
 * were cleared. */
export function clearUnlocked(kit) {
    let n = 0;
    for (const p of kit.pads) {
        if (!p.locked && p.sample) { p.sample = null; n++; }
    }
    if (n) kit.modified_at = nowIso();
    return n;
}

/* Remove the lock from every pad. Returns how many were actually unlocked. */
export function unlockAll(kit) {
    let n = 0;
    for (const p of kit.pads) {
        if (p.locked) { p.locked = false; n++; }
    }
    if (n) kit.modified_at = nowIso();
    return n;
}

/* Clear one pad if it is unlocked. Returns 'cleared' | 'locked' | 'empty'. */
export function clearPad(kit, padIndex) {
    const p = kit.pads[padIndex];
    if (p.locked) return 'locked';
    if (!p.sample) return 'empty';
    p.sample = null;
    kit.modified_at = nowIso();
    return 'cleared';
}

/* Per-pad playback gain, 0.0..2.0 (1.0 = 0 dB). */
export function setPadGain(kit, padIndex, gain) {
    const p = kit.pads[padIndex];
    if (!p) return 1.0;
    const g = Math.max(0, Math.min(2, Number(gain) || 0));
    p.playback.gain = g;
    kit.modified_at = nowIso();
    return g;
}

export function gainToDbLabel(gain) {
    const g = Number(gain);
    if (!(g > 0)) return '-inf dB';
    const db = 20 * Math.log10(g);
    return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
}
