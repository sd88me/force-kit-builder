/*
 * Force Kit Builder — kit schema validation.
 *
 * Ported from schwung-kit-builder's src/core/validation.mjs. `application`
 * is now 'force-kit-builder' instead of 'kit-builder' — everything else is
 * unchanged (the pad shape didn't change other than dropping ableton_uri,
 * which this validator never checked).
 *
 * Pure module. Returns null when a parsed kit document is structurally valid,
 * or a short human-readable reason string when it is not. Extra/unknown
 * fields are tolerated — only the load-bearing shape is checked. Missing
 * sample FILES are a separate concern (storage.markMissingSamples).
 */

export const ROLES = [
    'kick', 'snare', 'rim', 'clap', 'hat', 'closed_hat', 'open_hat',
    'tom', 'conga', 'percussion', 'crash', 'ride', 'cymbal', 'fx',
    'vox', 'bass', 'synth', 'stab', 'chord', 'lead', 'pad', 'other'
];

function isFiniteNum(x) {
    return typeof x === 'number' && isFinite(x);
}

export function validateKit(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not an object';
    if (doc.schema_version !== 1) return `unsupported schema_version (${doc.schema_version})`;
    if (doc.application !== 'force-kit-builder') return `unexpected application (${doc.application})`;
    if (typeof doc.name !== 'string') return 'name must be a string';
    if (!Array.isArray(doc.pads) || doc.pads.length !== 16) return 'pads must be an array of 16';

    for (let i = 0; i < 16; i++) {
        const p = doc.pads[i];
        const at = `pad ${i + 1}`;
        if (!p || typeof p !== 'object') return `${at}: not an object`;
        if (p.pad !== i + 1) return `${at}: pad number is ${p.pad}`;
        if (!Number.isInteger(p.midi_note) || p.midi_note < 0 || p.midi_note > 127) {
            return `${at}: bad midi_note`;
        }
        if (typeof p.locked !== 'boolean') return `${at}: locked must be boolean`;
        if (typeof p.role !== 'string' || !p.role) return `${at}: missing role`;

        if (p.sample !== null) {
            if (typeof p.sample !== 'object' || Array.isArray(p.sample)) return `${at}: bad sample`;
            if (typeof p.sample.filesystem_path !== 'string' || !p.sample.filesystem_path) {
                return `${at}: sample has no filesystem_path`;
            }
            if (typeof p.sample.filename !== 'string' || !p.sample.filename) {
                return `${at}: sample has no filename`;
            }
        }

        if (!p.playback || typeof p.playback !== 'object' || !isFiniteNum(p.playback.gain)) {
            return `${at}: bad playback.gain`;
        }
    }
    return null;
}
