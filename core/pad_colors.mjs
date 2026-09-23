/*
 * Force Kit Builder — per-category pad colours.
 *
 * A category -> hex colour map (no leading '#', matching force_shadow.c's
 * `color=RRGGBB` conf convention, so the same stored value can drive both the
 * web GUI's CSS and, later, the shadow-GUI's frame colouring and the XPM
 * export's pad colour). Web GUI call sites prepend '#' themselves.
 *
 * Defaults are the real Akai factory-kit convention, not an invented
 * palette: derived by scanning all 250 factory .xpm kits shipped on a live
 * Force (sample name -> detected category -> that pad's ProgramPads-v2.10
 * colour value), not guessed. Per-category consistency ranged 74-100% for
 * every category with enough factory samples to judge (n=6 to n=815); a few
 * categories with little/no factory data (glitch, pad, other) are grouped
 * with their nearest well-attested neighbour instead of inventing a colour.
 */

export const DEFAULT_PAD_COLORS = {
    kick: '7f0000',
    snare: '7f7f00',
    rim: '7f7f00',
    clap: '7f7f00',
    hat: '5f3300',
    closed_hat: '5f3300',
    open_hat: '5f3300',
    tom: '229ed0',
    conga: '229ed0',
    percussion: '229ed0',
    crash: '5f3300',
    ride: '5f3300',
    cymbal: '5f3300',
    fx: 'ee2288',
    glitch: 'ee2288',
    vox: '00007f',
    bass: '007f00',
    synth: 'a000ff',
    stab: '50007f',
    chord: 'a000ff',
    lead: '50007f',
    pad: 'a000ff',
    other: '555555'
};

const HEX6_RE = /^[0-9a-fA-F]{6}$/;

/* Merge a partial/untrusted override map over the defaults — unknown keys
 * dropped, malformed values (not exactly 6 hex digits) skipped so a bad
 * write from the color-picker UI can't corrupt config.json with garbage the
 * native shadow-GUI colour lookup or the XPM writer would then have to
 * guard against too. */
export function mergePadColors(over) {
    const out = Object.assign({}, DEFAULT_PAD_COLORS);
    if (over && typeof over === 'object') {
        for (const k of Object.keys(out)) {
            const v = over[k];
            if (typeof v === 'string' && HEX6_RE.test(v)) out[k] = v.toLowerCase();
        }
    }
    return out;
}
