/*
 * Force Kit Builder — Akai MPC .xpm export
 *
 * This is a pure module (caller injects write/mkdir/copy/frameCount), so the
 * export logic itself needs no host-specific plumbing. `opts.dir` is
 * REQUIRED and never defaulted inside this module — an earlier version of
 * this exporter defaulted it to a hardcoded export-root path, which is gone
 * now. Confirmed live over SSH on 2026-09-18 (see DESIGN.md): the Force's
 * own factory expansion kits live flat under
 * `/media/az01-internal-sd/Expansions/Kits & Patterns/`, `.xpm` sitting
 * directly beside its `.wav` samples, no manifest/registration needed — so
 * that path is the right *suggested* default for a destination-folder
 * picker to pre-fill, but it's the caller's job to supply it (as the web
 * UI's picker now does); this module still refuses to guess.
 *
 * The MPC program format is not documented; per github.com/psrpinto/roger the
 * safe approach is to take a real exported .xpm as a template and change only
 * what must change. `xpm_template.mjs` holds that reference (an MPC-V 2.1 Drum
 * program) split into structural chunks. Here we:
 *   - set <ProgramName>
 *   - emit 128 <Instrument> blocks (the MPC always writes the full pad
 *     complement); for kit pads 1..16 with a sample, set Layer 1's
 *     <SampleName>; empty pads keep the template's empty name
 *   - regenerate <PadNoteMap> (Note = 35 + pad) and <PadGroupMap> (all 0)
 * Everything else — per-pad envelopes, filters, LFO, pad colours in
 * <ProgramPads-v2.10> — is kept byte-for-byte from the reference.
 *
 * Samples are referenced by their own basename (extension dropped, made
 * filesystem/XML-safe); the MPC loads `<SampleName>.wav` from the .xpm's own
 * folder. When the caller supplies copy(src, dest) the export gathers each
 * source file into that folder as `<SampleName><ext>`; otherwise (and for any
 * copy that fails) MANIFEST.txt lists what to place by hand.
 * `<SliceEnd>` must be the sample's real frame count — SliceStart 0 + SliceEnd
 * 0 is a zero-length region, so leaving it at the reference layer's inert `0`
 * played silence on a real Akai Force (confirmed on hardware — this is the
 * single most load-bearing fact in this whole exporter, preserve it in any
 * future rewrite). When the caller supplies frameCount(sourcePath), it's used
 * for every assigned pad; a pad whose length can't be determined keeps
 * SliceEnd 0 and gets a warning.
 *
 * Pure module: no filesystem access. Caller supplies write()/mkdir()/copy()/
 * frameCount().
 */

import {
    XPM_HEAD, XPM_PROGPADS, XPM_PROG_PARAMS, XPM_INSTRUMENT, XPM_TAIL,
    XPM_SAMPLENAME_MARK, XPM_SLICEEND_MARK, toCRLF
} from './xpm_template.mjs';

const N_INSTR = 128;    // MPC drum program: always 128 pads
const KIT_PADS = 16;
const NAME_MAX = 42;

function slug(s) {
    const t = String(s == null ? '' : s)
        .replace(/^.*[\/\\]/, '')                 // keep basename only
        .replace(/\.[^.]+$/, '')                  // drop extension
        .replace(/[^A-Za-z0-9 ()_-]+/g, '_')      // keep spaces + parens; other punctuation -> _
        .replace(/\s+/g, ' ')                     // collapse whitespace runs
        .replace(/^[ _-]+|[ _-]+$/g, '');
    return t || 'sample';
}

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/*
 * parseXpm(text) -> { name, pads: [{ padNum, sampleName } | null] }  (pads.length === 16)
 *
 * Reads an existing .xpm back out, for the web UI's "Load XPM" feature.
 * Extracts <ProgramName> and, for Instrument numbers 1..16 only, Layer 1's
 * <SampleName> (empty string => that pad has no sample; the array slot stays
 * null only when the Instrument itself is entirely absent from the file).
 *
 * v1 LIMITATION (deliberate, document loudly): this assumes Instrument N in
 * the XML *is* physical pad N — true for every .xpm this project's own
 * exporter produces (see buildXpm() above) and for every real factory/
 * AutoMpcKitter-style file inspected during this project (Instruments always
 * emitted in ascending order starting at 1). A real MPC program COULD in
 * principle remap pads to arbitrary Instrument numbers via <PadNoteMap>; this
 * importer does not follow that indirection. Good enough for "load a kit this
 * tool (or a typical factory pack) made, keep editing it" — not a general MPC
 * program reader.
 *
 * Stops scanning once Instrument 16 has been seen (real files emit ascending
 * order, and a full drum program is ~1MB/128 instruments — no reason to keep
 * regex-scanning the other 112 we'll never use).
 *
 * Pure function — no fs access. Never throws: malformed/truncated input just
 * yields whatever could be found (a completely unparseable string yields
 * `{ name: null, pads: 16×null }`).
 */
export function parseXpm(text) {
    const s = String(text == null ? '' : text);
    const nameMatch = /<ProgramName>([\s\S]*?)<\/ProgramName>/.exec(s);
    const name = nameMatch ? xmlUnescape(nameMatch[1]) : null;

    const pads = new Array(KIT_PADS).fill(null);
    const instrRe = /<Instrument number="(\d+)">([\s\S]*?)<\/Instrument>/g;
    let m;
    while ((m = instrRe.exec(s))) {
        const n = parseInt(m[1], 10);
        if (n > KIT_PADS) break;          // ascending order in every real file — done
        if (n < 1) continue;
        const layerMatch = /<Layer number="1">([\s\S]*?)<\/Layer>/.exec(m[2]);
        const sampleMatch = layerMatch ? /<SampleName>([^<]*)<\/SampleName>/.exec(layerMatch[1]) : null;
        pads[n - 1] = { padNum: n, sampleName: sampleMatch ? xmlUnescape(sampleMatch[1]) : '' };
        if (n === KIT_PADS) break;
    }
    return { name, pads };
}

/* MPC sample name = the source file's own basename, extension dropped,
 * filesystem/XML-safe (spaces kept), capped at NAME_MAX. The MPC loads
 * "<SampleName>.wav" from the .xpm's folder, so the gathered copy is named to
 * match. Duplicate names across pads are disambiguated in buildXpm(). */
export function mpcSampleName(filename) {
    let name = slug(filename);
    if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).replace(/[ _-]+$/, '');
    return name;
}

/* One <Instrument number="n"> block. `sampleName` '' => empty pad, which in a
 * real MPC export differs from a populated pad by two inert defaults
 * (WarpTempo 120 vs 20, Layer-1 SliceLoopCrossFadeLength -1 vs 0) — matched
 * here so the file is byte-identical in shape to the reference. `sliceEnd`
 * is the pad's real frame count (0 if unknown/empty — see module doc). */
function instrumentBlock(n, sampleName, sliceEnd) {
    let b = XPM_INSTRUMENT.replace('<Instrument number="1">', `<Instrument number="${n}">`);
    b = b.replace(XPM_SAMPLENAME_MARK, `<SampleName>${xmlEscape(sampleName)}</SampleName>`);
    b = b.replace(XPM_SLICEEND_MARK, `<SliceEnd>${sliceEnd | 0}</SliceEnd>`);
    if (!sampleName) {
        b = b.replace('<WarpTempo>20.000000</WarpTempo>', '<WarpTempo>120.000000</WarpTempo>');
        b = b.replace('<SliceLoopCrossFadeLength>0</SliceLoopCrossFadeLength>',
                      '<SliceLoopCrossFadeLength>-1</SliceLoopCrossFadeLength>');
    }
    return b;
}

function padNoteMap() {
    /* Note = 35 + pad, wrapped into MIDI range 0..127 (matches the reference:
     * pads 1..92 -> 36..127, pad 93 -> 0, ... pad 128 -> 35). */
    let s = '    <PadNoteMap>\n';
    for (let i = 1; i <= N_INSTR; i++) {
        s += `      <PadNote number="${i}">\n        <Note>${(35 + i) % 128}</Note>\n      </PadNote>\n`;
    }
    return s + '    </PadNoteMap>\n';
}

function padGroupMap() {
    let s = '    <PadGroupMap>\n';
    for (let i = 1; i <= N_INSTR; i++) {
        s += `      <PadGroup number="${i}">\n        <Group>0</Group>\n      </PadGroup>\n`;
    }
    return s + '    </PadGroupMap>\n';
}

/*
 * Pad colours: `<ProgramPads-v2.10>`'s `pads.valueN` (N=0..15, pad N+1) holds
 * the pad's LED colour as a plain decimal RGB integer (R*65536+G*256+B) —
 * confirmed by pulling real factory .xpm files off a live Force and decoding
 * their `pads` block (e.g. #7f0000 -> 8323072), not guessed. `value16..127`
 * (unused-pad slots in every real 16-pad export inspected) and `universalPad`
 * are left at the reference template's own values; only the 16 real pad
 * slots are touched, one regex-anchored replace per pad so the rest of the
 * template (JSON key order, whitespace, XML-escaping) stays byte-identical.
 * A pad whose role has no entry in `padColors` keeps the template's default
 * for that slot.
 */
function buildProgPads(kit, padColors) {
    if (!padColors) return XPM_PROGPADS;
    let s = XPM_PROGPADS;
    const pads = (kit && kit.pads) || [];
    for (let i = 0; i < KIT_PADS; i++) {
        const role = pads[i] && pads[i].role;
        const hex = role ? padColors[role] : null;
        if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) continue;
        const dec = parseInt(hex, 16);
        s = s.replace(new RegExp(`&quot;value${i}&quot;: \\d+`), `&quot;value${i}&quot;: ${dec}`);
    }
    return s;
}

/*
 * buildXpm(kit, opts) -> { text, warnings, padCount, manifest }
 * `manifest` is [{ pad, sampleName, sourcePath, ext, destName }] for the
 * assigned pads. destName = sampleName + source ext — the file the MPC wants
 * sitting next to the .xpm. `opts.frameCount(sourcePath) -> number|null` is
 * called once per assigned pad to fill in Layer 1's <SliceEnd>; omit it (or
 * return null/0) and that pad's SliceEnd stays 0, with a warning.
 * `opts.padColors` (optional) -> { category: 'rrggbb' } — see buildProgPads().
 */
export function buildXpm(kit, opts) {
    const frameCount = (opts && typeof opts.frameCount === 'function') ? opts.frameCount : null;
    const warnings = [];
    const name = (kit && kit.name) || 'Kit Builder';
    const pads = (kit && kit.pads) || [];

    const manifest = [];
    const seen = {};
    const instrs = [];
    for (let n = 1; n <= N_INSTR; n++) {
        let sn = '';
        let sliceEnd = 0;
        if (n <= KIT_PADS) {
            const p = pads[n - 1];
            if (p && p.sample && p.sample.filesystem_path) {
                sn = mpcSampleName(p.sample.filename || p.sample.filesystem_path);
                if (seen[sn]) sn = (sn + ' ' + n).slice(0, NAME_MAX);
                seen[sn] = true;
                const fs = p.sample.filesystem_path;
                if (fs.charAt(0) !== '/') warnings.push(`pad ${n}: sample path is not absolute`);
                const dot = fs.lastIndexOf('.');
                const ext = dot > fs.lastIndexOf('/') ? fs.slice(dot).toLowerCase() : '.wav';
                manifest.push({ pad: n, sampleName: sn, sourcePath: fs, ext, destName: sn + ext });

                if (frameCount) {
                    const frames = frameCount(fs);
                    if (frames > 0) sliceEnd = frames;
                    else warnings.push(`pad ${n}: could not read sample length — may play silent on some MPC/Force firmware`);
                }
            }
        }
        instrs.push(instrumentBlock(n, sn, sliceEnd));
    }

    const progName = `    <ProgramName>${xmlEscape(name)}</ProgramName>\n`;
    const text =
        toCRLF(XPM_HEAD + progName) +
        buildProgPads(kit, opts && opts.padColors) +
        toCRLF(XPM_PROG_PARAMS + instrs.join('') + '    </Instruments>\n' + padNoteMap() + padGroupMap()) +
        toCRLF(XPM_TAIL);

    return { text, warnings, padCount: manifest.length, manifest };
}

/* manifestText(manifest, { attempted }) -> string
 * `attempted` true => the export tried to copy the WAVs itself; each row is
 * tagged [gathered] or [MISSING] (a MISSING row must be placed by hand). */
export function manifestText(manifest, opts) {
    const attempted = !!(opts && opts.attempted);
    const rows = (manifest || []).map((m) => {
        const dest = m.destName || (m.sampleName + '.wav');
        const tagStr = attempted ? (m.gathered ? '\t[gathered]' : '\t[MISSING — copy by hand]') : '';
        return `${dest}\t${m.sourcePath}${tagStr}`;
    }).join('\n');
    const head = attempted
        ? 'Force Kit Builder MPC export — the files below were copied next to this .xpm.\n' +
          'Any row tagged [MISSING] must be placed by hand (keep the left-hand name).\n\n'
        : 'Force Kit Builder MPC export — place each source file next to this .xpm,\n' +
          'keeping the left-hand name (the MPC matches samples by name).\n\n';
    return head + rows + '\n';
}

/*
 * exportXpm(kit, { dir, name, write, mkdir, copy, frameCount }) ->
 *     { ok, path, dir, warnings, errors, padCount, gathered }
 *   dir                                    (required) — destination folder,
 *       always caller-supplied (the web UI's folder picker); no hardcoded
 *       default (see module doc)
 *   write(path, string) -> boolean        (required)
 *   mkdir(path)                           (optional)
 *   copy(srcPath, destPath) -> boolean    (optional) — gather the WAVs beside
 *       the .xpm; a falsy return leaves that sample for MANIFEST.txt
 *   frameCount(srcPath) -> number|null    (optional) — see buildXpm() doc
 * `gathered` is the count of samples copied in. Never throws.
 */
export function exportXpm(kit, opts) {
    opts = opts || {};
    if (!kit || !Array.isArray(kit.pads)) return { ok: false, errors: ['no kit'], warnings: [] };
    if (!opts.dir) return { ok: false, errors: ['no destination directory supplied'], warnings: [] };

    const { text, warnings, padCount, manifest } = buildXpm(kit, opts);
    if (padCount === 0) return { ok: false, errors: ['kit has no assigned pads'], warnings };

    const base = String(opts.name || kit.name || 'Kit Builder').replace(/[\/\\]/g, '_');
    const dir = opts.dir + '/' + base;
    if (typeof opts.mkdir === 'function') opts.mkdir(dir);

    const xpmPath = `${dir}/${base}.xpm`;
    if (typeof opts.write !== 'function') return { ok: false, errors: ['no write() provided'], warnings, path: xpmPath, text };
    if (!opts.write(xpmPath, text)) return { ok: false, errors: ['xpm write failed'], warnings, path: xpmPath };

    /* Gather the audio into the .xpm's folder when the caller can copy files.
     * Non-fatal: MANIFEST.txt still lists every source, tagged with the
     * outcome, so a failed copy just falls back to a manual step. */
    const canCopy = typeof opts.copy === 'function';
    let gathered = 0;
    for (const m of manifest) {
        if (m.ext && m.ext !== '.wav') {
            warnings.push(`pad ${m.pad}: source is ${m.ext}; the MPC loads ${m.sampleName}.wav beside the .xpm`);
        }
        if (!canCopy) { m.gathered = false; continue; }
        m.gathered = !!opts.copy(m.sourcePath, `${dir}/${m.destName}`);
        if (m.gathered) gathered++;
        else warnings.push(`pad ${m.pad}: could not copy ${m.sourcePath}`);
    }

    opts.write(`${dir}/MANIFEST.txt`, manifestText(manifest, { attempted: canCopy }));   // best-effort

    return { ok: true, path: xpmPath, dir, warnings, errors: [], padCount, gathered };
}
