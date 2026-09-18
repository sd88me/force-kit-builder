# Force Kit Builder — design

A web-based drum-kit builder for the Akai Force running MockbaMod. Ports
[schwung-kit-builder](https://github.com/) (the Ableton Move "Schwung"
overtake module for building 16-pad drum kits from a sample library) to the
Force — keeping the kit-building engine, dropping every Ableton/Move preset
format, keeping only Akai MPC `.xpm` export written directly to the Force's
own local disk, and replacing the on-device hardware-button UI entirely with
a browser UI shaped like a 16-pad grid.

## Architecture: a nodeServer module, not a standalone addon

Every other `force-*` port in this family (`force-acid`, `force-dx7`,
`force-jv880`, `force-maze`) ships as its **own standalone MockbaMod addon**
with its own dedicated port (8303, 8304/8305, 8306, 8307) and a small
redirect-stub patch (`nodeserver-integration/*.js`) into nodeServer so it
also gets a link on nodeServer's home page. That pattern exists because those
addons are real-time MIDI/synth-emulation processes — they *have* to run as
their own continuously-live process, independent of anything else, and the
redirect stub is only there for discoverability.

Kit Builder has none of that. It's pure request/response: scan folders,
mutate a JSON kit document, write an XPM. No continuous process, no MIDI, no
state that needs to survive between requests except files on disk. There's
no real reason it needs its own port or its own addon-boot-loop entry — and
building it that way would mean reimplementing a folder browser nodeServer
already has.

So this ships as a **nodeServer client-app + API module** instead — the same
way `file-browser`, `moduler`, `RIFFMAKER4T` and nodeServer's own `/tooling`
XPM helpers already live inside nodeServer's own process:

- `plugin/api/endpoints/kitbuilder/index.js` implements nodeServer's own
  `INIT(req, res, NS)` routing contract (a `switch` on the URL's third path
  segment, exactly like `file-browser/index.js` and `app-template/index.js`
  do it) and serves both the page and every JSON action.
- One entry gets added to nodeServer's own `app/api/ENDPOINTS.js` (see
  `plugin/ENDPOINTS.patch.md`) — a plain in-process route, not a redirect.
- The source-folder and export-destination pickers call nodeServer's
  **existing** `POST /file-browser/LIST` endpoint directly — this plugin
  does not reimplement a file browser at all.
- No port to allocate, no `manage.sh`/`run_*.sh`/`NSMODULE.json`, no addon
  boot-loop entry — nodeServer's own process and watchdog cover it.

**The real tradeoff**: this makes an existing nodeServer install a hard
dependency, rather than an optional link the way the other `force-*` addons
treat it. Given nodeServer is already the base every other addon in this
family links into, that seemed like the right call rather than a cost — but
it's a genuine coupling, not a free lunch, and it's worth knowing if you're
setting this up on a Force that doesn't already run nodeServer.

## Distribution model

This repo is not itself something you drop into `AddOns/`. It's a patch you
apply to an *existing* nodeServer install:

```
./install.sh /media/662522/AddOns/nodeServer/app
```

`install.sh` copies `core/` + `exporters/` into a `kitbuilder-core/` folder
inside nodeServer's own `app/` directory, copies
`plugin/api/endpoints/kitbuilder/` into nodeServer's own
`api/endpoints/kitbuilder/`, and prints the one-line `ENDPOINTS.js` addition
if it's not already there (never edits that file automatically — see the
script's own comments for why). This mirrors exactly how the
`nodeserver-integration/` folders in `force-acid`/`force-dx7`/`force-jv880`
already document a manual patch to an existing nodeServer install; this repo
just patches in a full feature instead of a one-line redirect stub.

`kitbuilder-core/data/` (the working kit, sample index cache, preferences,
config) is created on first use and is never touched by a re-run of
`install.sh` — only `core/` and `exporters/` get replaced on an upgrade.

## What ported, what got cut

schwung-kit-builder's `src/core/*.mjs` were already written as "pure modules"
— no `os`/`host_*` QuickJS shims baked into the actual logic, host access
injected by the caller — which made most of them port over close to
verbatim:

| Module | Fate |
|---|---|
| `kit_model.mjs` | Ported. Dropped `sample.ableton_uri` and the `source: 'user'\|'core'` binary — no Move URI scheme, no fixed two-library split here. `sample.source` is now a free-text label (the root folder path it came from). |
| `sample_classifier.mjs` | Ported verbatim — the 22-category folder/filename classifier has zero Move dependency. |
| `random_assign.mjs` | Ported. The `source` filter changed from `'user'\|'core'\|'both'` to "an exact root-folder path, or `'all'`/omitted for no filter" — see `bucketByRole()`'s doc. |
| `scan_filters.mjs` | Ported verbatim. |
| `sample_index.mjs` | Ported. QuickJS `os.stat`/`os.readdir`/`host_*` replaced with plain Node `fs`. `sample_roots: {user, core}` replaced with `sample_roots: string[]` — an arbitrary, user-picked list of folders. `toAbletonUri` removed entirely. |
| `storage.mjs` | Ported. QuickJS shims replaced with `fs`. `exportMrDrums()` and the entire SSH "push to Force" subsystem (`ensureForceKey`, `pushKitToForce`, vendored dropbear binaries) are gone — moot once the tool *is* the Force. `wav_strip.mjs`'s copy-time WAV-metadata stripping is gone too — it only existed to shrink a lossy string-round-trip copy path on Move; `fs.copyFileSync` here is an exact byte-for-byte copy with nothing to strip. |
| `loudness.mjs` | Ported verbatim (pure math). |
| `wav_info.mjs` | Ported. `base64Decode()` dropped — it only existed because Move's `host_read_file_base64` was the one binary-safe read primitive on that host; `fs.readFileSync()` returns a real `Buffer` directly, no round-trip needed. |
| `wav_rms.mjs` | **New.** Move's loudness readings came from the native DSP (`get_param("loudness")`); there's no DSP here, so this reads each pad's own WAV file directly and computes RMS server-side in Node — no Web Audio, no browser round-trip, fully headless. |
| `validation.mjs` | Ported (just `application: 'force-kit-builder'` instead of `'kit-builder'`). |
| `exporters/mpc_xpm.mjs` | Ported. The one real change: `MPC_EXPORT_ROOT` (a hardcoded Move path default) is gone — `opts.dir` is now **required**. See "Open item" below for why. |
| `exporters/xpm_template.mjs` | Copied byte-for-byte — pure XML/JSON template data, zero Move dependency to begin with. |
| `exporters/mrdrums_json.mjs` | **Cut entirely.** Ableton drum-rack (`.ablpreset`) export — the format this port explicitly drops. |
| `path_mapping.mjs` | **Cut entirely.** The `ableton:/user-library/...` URI scheme has no Force equivalent. |
| `src/dsp/kit_player.c` + native plugin ABI | **Cut entirely.** Move's native-plugin sample-audition player. A browser can audition samples trivially via `<audio>` hitting a streaming endpoint — no native code needed. |
| `src/vendor/dropbear-aarch64/` | **Cut entirely.** The SSH-push binaries, moot per above. |
| `src/ui.js` (2019 lines) | **Cut entirely.** Move-hardware-specific (pad MIDI/jog-wheel/Shift-Back-Rec-Play semantics, RGB LED painting, on-screen keyboard, `overtake` module lifecycle). Only the *actions it orchestrated* — Assign/Clear/Unlock All/Save/Rescan/reroll-one-pad/reject/favourite/Match Levels/Export — are the reusable contract; the web UI re-implements calls to the same core modules. |
| `src/module.json` | Replaced by nodeServer's own `ENDPOINTS.js` entry — no Schwung/Overtake manifest concept applies here. |

## Data model

A kit is 16 pads, unchanged in shape from the Move original except for the
`ableton_uri`/`source` changes noted above:

```js
{
  schema_version: 1, application: 'force-kit-builder', kit_id, name,
  created_at, modified_at, random_seed: 0, prevent_duplicates: true,
  pads: [ /* exactly 16 */ ]
}
```

Each pad:

```js
{
  pad: 1..16, midi_note: 36..51, role: 'kick', locked: false,
  sample: null | { filesystem_path, source, filename, category, missing? },
  playback: { gain: 1.0 }   // 0.0–2.0, 1.0 = 0 dB — no pan/tune/choke-group
}
```

## Category/pool system

23 flat categories (`kick snare rim clap hat closed_hat open_hat tom conga
percussion crash ride cymbal fx glitch vox bass synth stab chord lead pad
other`) — `glitch` (aliases: `glitch`, `glitches`, `glitchy`, `grain`,
`grains`, `granular`) was split off `fx` (which used to also claim
`glitch`/`glitches` before `buildAliasIndex()`'s first-writer-wins rule made
that ambiguous) as its own category, added after this project's initial
build. It has no dedicated pad slot, so — like every other unslotted category
— it falls into pads 13-16's catch-all pool automatically via
`random_assign.mjs`'s `otherPoolCats()`, and into the SYSTEM status panel's
"Other" line automatically via `sample_index.mjs`'s `summarize()` (neither
needed a code change beyond adding the category itself; that's the payoff of
those two functions computing "everything not explicitly slotted" instead of
a fixed list).
classified by folder path (deepest match wins) with a filename-token fallback
when the folder yields nothing. Each of the 16 pads draws from a **union** of
one or more categories (`pad_layout`); pad 12 is always `fx`, pads 13–16 are
a sentinel that expands to every category with no dedicated slot plus `fx`.
This is unchanged from the Move original — see `core/sample_classifier.mjs`
and `core/sample_index.mjs`'s `DEFAULT_CONFIG.role_rules`/`pad_layout` for
the full vocabulary.

**Per-pad pool picker** (the web UI's one new interactive feature over the
Move original's fixed layout): each pad tile has a dropdown letting you pick
a single category to override that pad's pool. This writes to
`config.pad_layout[pad]` via `storage.savePadLayoutEntry()` — config-wide
(like the Move original), not per-kit: it changes which pool that pad slot
draws from for every future Assign/Reroll, on any kit, until changed again.

## Lock / reject / favourite

Unchanged semantics from the Move original:

- **Lock** (per-pad, part of the kit itself): excluded from Assign and Clear,
  keeps its sample across a rescan, counts as "already used" for
  duplicate-prevention. Locking an empty pad is allowed.
- **Reject / favourite** (library-wide, not per-kit or per-pad — stored as
  two flat path sets in `preferences.json`): mutually exclusive per sample.
  Reject removes a sample from every future candidate pool permanently
  (never relaxed). Favourite doubles a sample's pick weight in Assign/Reroll.

## XPM export

`exporters/mpc_xpm.mjs` template-substitutes a real captured MPC-V 2.1 drum
program (`xpm_template.mjs`) rather than generating XML from scratch — the
format is undocumented, so keeping everything byte-for-byte except what must
change is the only safe approach (method per
[github.com/psrpinto/roger](https://github.com/psrpinto/roger)). Per export:
`<ProgramName>` is set, all 128 `<Instrument>` blocks are emitted (an MPC
drum program always has the full pad complement — kit pads 1–16 map onto
instruments 1–16), and each assigned pad's Layer-1 `<SampleName>`/`<SliceEnd>`
are set.

**The single most load-bearing fact in this exporter**: `<SliceStart>0</
SliceStart>` + `<SliceEnd>0</SliceEnd>` is a zero-length region and plays
**silence on real Akai Force hardware** (confirmed on hardware during the
original Move project) — so every assigned pad's `SliceEnd` must be set to
the sample's real PCM frame count, computed by `wav_info.mjs`'s WAV-chunk
walker. This must survive any future rewrite of this exporter.

Output is one self-contained folder per kit: `<dir>/<KitName>/<KitName>.xpm`
+ every sample copied in beside it (named to match `<SampleName>`, matching
what the MPC expects to find next to the `.xpm`) + a `MANIFEST.txt` listing
every source path, tagged `[gathered]` or `[MISSING — copy by hand]`.

No sample-rate/bit-depth/mono-stereo normalization happens anywhere in this
pipeline — files pass through as exact byte copies (`fs.copyFileSync`); only
the WAV header is read, to measure frame count and (for Match Levels) RMS.

### Export destination — confirmed on real hardware 2026-09-18

Checked live over SSH (192.168.1.44, same discipline `force-acid`'s and
`force-shadow`'s own DESIGN.md files use for load-bearing hardware facts —
don't guess these, verify them): `/media/az01-internal-sd/projects/*_
[ProjectData]/` (a Force project's own sample folder) contains **no** `.xpm`
files at all — a Project's own Programs aren't stored as loose `.xpm` files,
so that's not the right place. The Force's actual factory content lives at
`/media/az01-internal-sd/Expansions/Kits & Patterns/` — inspected directly
(e.g. the "Mainroom" pack): every `.xpm` sits **flat, directly beside its
own `.wav` samples**, mixed in with every other pack's files in the same
folder, no per-pack subfolder, no manifest or registration file of any kind.
This confirms the exporter's own long-standing "self-contained folder,
`<SampleName>.wav` beside the `.xpm`" convention is exactly right, and that
nothing beyond plain files needs to exist for the Force to browse to and
load a kit from a folder.

`exportMpcXpm(kit, name, destDir)` still takes `destDir` as a **required**
argument — this repo still refuses to hardcode a destination inside the
exporter itself. What changed: the web UI's destination-folder picker now
*opens to* `/media/az01-internal-sd/Expansions/Kits & Patterns` by default
(see `SUGGESTED_EXPORT_DIR` in `plugin/api/endpoints/kitbuilder/client.js`)
as a confirmed-sane starting point, not an auto-selected value — you still
have to browse in and hit Select. A live install of this plugin also wrote
a real generated smoke-test kit to a `ForceKitBuilder-SmokeTest` subfolder
there to confirm the file layout lands correctly (see the Testing section);
whether the Force's own Program browser actually *loads and plays* it still
needs eyes on the physical touchscreen, which this session couldn't do
remotely — that's the one piece still worth a manual check next time you're
at the device.

## API (served by `plugin/api/endpoints/kitbuilder/index.js`)

Routed on the URL's third segment (`/kit-builder/<ACTION>`), matching
nodeServer's own `file-browser`/`app-template` convention exactly. Every
action except `LIST` (the page itself), the two static assets, and `AUDIO`
is a `POST` with a JSON body, replying `{ ok: true, ... }` or
`{ ok: false, error }`.

| Action | Body | Does |
|---|---|---|
| `STATE` (GET) | — | Current kit + config + index summary + rejects/favourites — the one call the client polls after every mutation. |
| `SET_ROOTS` | `{ roots: string[] }` | Replace the selected sample-source folders. |
| `RESCAN` | `{ scan_filters? }` | Re-scan every configured root, rebuild the sample index. |
| `ASSIGN` | `{ seed?, source?, preventDuplicates? }` | Randomly fill every unlocked pad. |
| `REROLL` | `{ padIndex, seed?, source?, preventDuplicates? }` | Re-roll one unlocked pad. |
| `SET_PAD` | `{ padIndex, action: 'toggle_lock'\|'clear'\|'gain', value? }` | Per-pad mutations. |
| `SET_POOL` | `{ padIndex, category }` (or `categories: string[]`) | Override which categories one pad slot draws from. |
| `CLEAR_ALL` | — | Clear every unlocked pad. |
| `UNLOCK_ALL` | — | Drop every lock. |
| `NEW_KIT` | — | Start a fresh, blank kit. |
| `FAVREJECT` | `{ path, action: 'favourite'\|'reject'\|'clear'\|'clear_all_favourites'\|'clear_all_rejects' }` | Library-wide preference mutation. |
| `MATCH_LEVELS` | — | Measure each assigned pad's RMS and attenuate to match. |
| `SAVE` | `{ name, overwriteName? }` | Write the working `.kitbuilder.json`. |
| `EXPORT` | `{ name, destDir }` | Write the MPC `.xpm` + samples + MANIFEST to `destDir`. |
| `IMPORT_XPM` | `{ path }` | Load an existing `.xpm` (picked via the same file-browser modal, in file-picking mode) and replace the whole working kit with it — see "Loading an existing .xpm" below for the v1 limitation. |
| `AUDIO/<encodeURIComponent(path)>` (GET) | — | Streams one sample for audition — **only** a path already known to the current kit or the loaded index; never an arbitrary query path (see the handler's own doc for the reasoning). |

## Loading an existing .xpm

`exporters/mpc_xpm.mjs`'s `parseXpm(text)` is the read side of the same
template-based approach `buildXpm()` uses to write — a couple of regexes
pulling `<ProgramName>` and, for Instrument numbers 1-16, Layer 1's
`<SampleName>`, rather than a real XML parser (consistent with the rest of
this exporter's "keep it a template, not a schema" philosophy).

**v1 limitation, load-bearing, worth restating outside the code comment too**:
this assumes Instrument N in the XML *is* physical pad N. That's true for
every `.xpm` this project's own exporter produces, and — confirmed live
against a real factory file, `Expansions/Kits & Patterns/Mainroom-Kit-Ultra.xpm`
(1MB, pulled and parsed directly, all 16 pads resolved correctly with zero
warnings) — true for standard factory/AutoMpcKitter-style content too, since
Instruments are always emitted in ascending order starting at 1. A real MPC
program *could* in principle remap pads to arbitrary Instrument numbers via
`<PadNoteMap>`; this importer doesn't follow that indirection. Good enough for
"load a kit this tool (or a typical factory pack) made, keep editing it" — not
a general-purpose MPC program reader.

The `IMPORT_XPM` action (`plugin/api/endpoints/kitbuilder/index.js`) resolves
each pad's `SampleName` (which never carries an extension — an MPC convention,
not something this tool invented) against the files actually sitting next to
the `.xpm`, case-insensitively, trying `.wav`/`.WAV`/`.aif`/`.AIF`/`.aiff`/
`.AIFF` in turn; anything not found is a warning, not a failed import.
Category is guessed from the resolved filename alone via the same
`classifyFilename()` fallback the scanner uses (there's no folder-hierarchy
context in a flat Expansions-style folder to do better than that). Per-pad
gain/volume from the source file is **not** preserved — MPC's own `<Volume>`
field uses an undocumented, likely non-linear curve, and guessing at a
conversion felt worse than just defaulting every imported pad to 1.0 (0 dB)
and being explicit about it here. This action replaces the whole working kit,
the same as `NEW_KIT` — it's a "start editing this kit" action, not a merge
into whatever was already open.

Client-side, "Load XPM…" reuses the existing folder-browser modal in a new
mode (`browserTarget: 'xpm-file'`): it lists `.xpm` entries from
`/file-browser/LIST`'s `FILES` array (confirmed live: `{path, name, type,
size, mtime, ...}`, `type` an uppercase extension with no dot) alongside the
usual folders, and clicking one calls `IMPORT_XPM` immediately rather than
"select and close" like the folder pickers do.

## Web UI

A 4×4 pad grid styled after real MPC/Force pad layouts (and the
[mpcsample.app](https://www.mpcsample.app/) pad-grid layout that inspired the
brief), plain vanilla JS with no build step or framework (`client.js`,
`style.css`, `template.html`) — matching nodeServer's own zero-build
convention rather than adding Vue/webpack/etc. for what's a fairly small
amount of DOM logic.

- **Each pad tile**: sample name, a colour-coded category badge, a clickable
  pool-override `<select>` right on the tile, lock/favourite/reject icon
  buttons, click-to-audition, and a border/background state that mirrors the
  original hardware's LED priority (missing → locked → assigned → empty).
- **Pad detail panel**: gain slider (dB readout), a waveform preview (see
  below), reroll/clear buttons, library-wide fav/reject counts.
- **Toolbar**: New, Assign, Clear, Unlock All, Match Levels, Save, Load XPM…,
  duplicate-avoidance toggle.
- **Source panel**: selected root folders (add via the file-browser modal,
  which calls nodeServer's own `/file-browser/LIST`), scan filters
  (skip-loops, max-size), Rescan, live index summary.
- **Export panel**: kit name, destination folder (same file-browser modal),
  Export button, warnings/manifest summary.

## Waveform preview

Shown once, in the pad-detail side panel, for whichever pad is currently
selected — not per-pad-tile. 16 simultaneous canvases decoding audio in
~130px tiles was considered and rejected: cramped, and wasteful decoding for
15 pads nobody's looking at. The side panel already exists for one pad's
detail at a time, so that's where this lives.

Entirely client-side, no server changes: `client.js` fetches the pad's sample
from the existing `/kit-builder/AUDIO/...` endpoint, decodes it with the
Web Audio API (`decodeAudioData`), downsamples channel 0 into one
{min,max} pair per canvas pixel column, and draws the envelope. Decoded
peaks are cached by `filesystem_path` (`waveformCache`) so the re-render that
follows every action (`refresh()` re-renders the whole pad detail panel) 
doesn't redundantly re-fetch/re-decode the same audio — only a genuinely new
pad selection triggers a fetch. A monotonically increasing token guards
against the one real race: clicking a different pad while a previous pad's
audio is still being fetched/decoded must not paint the stale result over the
now-current pad's canvas.

## Explicitly out of scope for this version

- Ableton `.ablpreset`/MrDrums export (the whole point of this port is
  XPM-only).
- The SSH "send to Force" push — moot, this *is* the Force.
- The Move original's post-MVP step-sequencer/pattern-audition page (E2) —
  it was already flagged post-MVP on the Move project too; nothing about
  this port changes that judgment.
- Any hardware-button/on-device-GUI control path at all.

## Testing

No Node.js runtime was available in the environment this was built in, so
`tests/run.js` is verified by running it inside a `node:20-slim` Docker
container (`docker run --rm -v $(pwd):/app -w /app node:20-slim node
tests/run.js`) rather than a bare `node` invocation — same test suite either
way, just note this if `node` genuinely isn't on your PATH either.

The plugin's `index.js` (the nodeServer endpoint itself) was additionally
verified end-to-end against a mocked nodeServer tree — a fake `static.js`, a
real generated sample library, and mock `req`/`res` objects driving every
action in sequence (`RESCAN` → `ASSIGN` → `SET_PAD`/`SET_POOL` →
`FAVREJECT` → `MATCH_LEVELS` → `SAVE` → `EXPORT` → `AUDIO`) — this is what
caught a real bug before it shipped: the original `AUDIO` action used a
`?path=` query string, which nodeServer's own `URL[2]`-based router can't
match against a plain `switch/case` (the query string rides along with the
segment); fixed to a `/AUDIO/<encoded-path>` segment, matching nodeServer's
own `file-browser` `READ`/`DOWNLOAD` convention. That integration harness
wasn't kept in the repo (it lived in a scratch directory) — if this project
grows, promoting some version of it into `tests/` would be worth doing
before it's forgotten.

### Live install pass (2026-09-18)

Installed for real onto the live device (192.168.1.44) via `install.sh
/media/662522/AddOns/nodeServer/app`, backing up the live `ENDPOINTS.js`
first (`ENDPOINTS.js.bak-20260918`, alongside it). Every assumption in this
doc's "Architecture" section checked out against the real nodeServer
code with zero surprises: `INIT(req, res, NS)`'s 3-arg signature, the
`URL[2]` switch-based router (nodeServer's own `app-template/index.js` has
a cosmetic no-op `.replace('/^\//', '')` bug — passes a literal string, not
a regex, so it never strips the leading slash — this plugin's `INIT()`
deliberately mirrors that exact line for consistency, since it doesn't
change the routing outcome either way), `static.HEAD/MENU/INCLUDE/CLOSE`,
the `|defer` suffix convention in `jsTag()`, and `/file-browser/LIST`'s
`{PATH} → {FOLDERS: [{name, path}, ...]}` shape — all confirmed byte-for-byte
via direct SSH inspection before relying on them. `node -e
"require('.../ENDPOINTS.js')"` confirmed the patched file parses cleanly;
`nodeServer/app/restart` (the same script its own watchdog calls) brought it
back up on ports 8080/443 both times this was restarted; `curl` against
`/kit-builder`, `/kit-builder/client.js`, and `POST /kit-builder/STATE` all
returned real, correctly-shaped responses (a genuine 16-pad kit, not a
mock). A real kit was also generated with the actual `exportMpcXpm()` (three
tiny synthesized WAVs, via the `node:20-slim` Docker approach above) and
copied onto the device as `Expansions/Kits & Patterns/
ForceKitBuilder-SmokeTest/` — files landed with correct structure and
non-zero sizes. What this *doesn't* confirm: whether the Force's own Program
browser actually loads and plays that kit — nobody was at the physical
touchscreen to check, so that's still the one open item, not the export
path itself (which is now confirmed, see above).

While tracing the `EXPORT` call path during this pass, `core/storage.mjs`
turned out to have a real latent bug from porting, unrelated to the
nodeServer integration: `sanitizeFilename()`'s control-character regex,
meant to read `/[\x00-\x1f\x7f]/g` as literal escape-sequence *text*, had
somehow been written with three actual raw control bytes (0x00, 0x1F, 0x7F)
substituted directly into the file instead. This didn't break anything at
runtime — V8 parses raw control bytes inside a regex character class just
fine, and the live `/kit-builder/STATE` call above proves the file loaded
and ran correctly even before the fix — but it made the file register as
binary ("data") to `file`, `grep`, and likely `git diff`, which is a real
maintainability trap for a file nobody would think to `xxd` first. Fixed by
replacing the three raw bytes with their proper 12-character escape-sequence
text; all 90 unit tests still pass unchanged. Worth a quick byte-level scan
(`grep -c` a raw NUL, or open in a hex-aware tool) on any future files
generated by a similar pipeline, since this one hid well enough that normal
review wouldn't catch it by reading the rendered text.

### Glitch category + XPM import + waveform pass

Added the `glitch` category, `IMPORT_XPM`, and the side-panel waveform in one
pass; 95/95 unit tests pass (90 prior + 1 new classifier case + 4 new
`parseXpm` cases in `tests/test_xpm_import.js`). `parseXpm()` was verified
against real content before being wired into the server at all: pulled
`Expansions/Kits & Patterns/Mainroom-Kit-Ultra.xpm` (1,032,268 bytes) directly
off the live device and ran it through the parser standalone first — all 16
pads resolved to plausible sample names — then round-tripped this exporter's
own `buildXpm()` output back through `parseXpm()` as a second sanity check,
before wiring `IMPORT_XPM` into `index.js` at all. Redeployed the same
push-files-then-`app/restart` process as the initial install; this time
`restart` returned cleanly instead of appearing to hang (both are normal —
whether the backgrounded node process holds the SSH pty open seems to depend
on timing, not a real failure signal either way). Live-exercised `IMPORT_XPM`
against that same real factory file over `curl`: `imported: 16, warnings: []`,
every pad correctly resolved and classified (e.g. `Mainroom-FX-MR FX 10.WAV`
→ `fx`, `Mainroom-Vocal-MR Vox 19.WAV` → `vox`) — concrete confirmation the
v1 "Instrument N = pad N" assumption holds for real factory content, not just
this project's own output. Reset the live working kit back to blank
afterward via `NEW_KIT` so the device wasn't left mid-test.

## Judgment calls worth knowing about

- **Test-harness circular import bug, fixed upstream of Move too**:
  schwung-kit-builder's `tests/run.js` put `assert`/`eq` directly in itself,
  and every `test_*.js` imported them back from `run.js` — a circular import
  between an async (top-level-`await`) module and its own dynamically
  imported children. This deadlocks on Node 20 (`process.exit(13)`,
  "unsettled top-level await", with **zero output**, no error message at
  all — it took real effort to track down). Fixed here by moving `assert`/
  `eq` into their own dependency-free `tests/assert.js`. Worth back-porting
  to schwung-kit-builder itself if its own test suite is ever run on a
  Node version newer than whatever it was last verified against.
- **`SET_POOL` is a new action** with no Move equivalent — the Move UI never
  exposed pad-pool reassignment as an interactive control; it lived in
  `kit_config.json`, edited by hand. Making it "selectable on the pad" was
  an explicit ask for this port.
- **`wav_rms.mjs` RMS is over the whole sample**, not a peak-window RMS like
  Move's native DSP produced — good enough for the attenuate-only relative
  ranking `loudness.mjs`'s `matchGains()` needs, not a broadcast-accurate
  loudness measurement. Revisit if that distinction ever matters.
- **No per-kit pool overrides** — `SET_POOL` is config-wide like the Move
  original's `pad_layout`, not stored on the kit document itself. If a
  future version wants "this kit's pad 6 is always crash, but other kits
  aren't," that's a data-model change, not a bug fix.
- **Imported pads always get gain 1.0** — see "Loading an existing .xpm"
  above; MPC's own per-pad `<Volume>` curve is undocumented, so this
  deliberately doesn't guess a conversion rather than silently mis-translate
  loudness on import.
- **`IMPORT_XPM` replaces the whole working kit**, same as `NEW_KIT` — there's
  no "merge this xpm's pads into my current kit" mode. Revisit if that turns
  out to be a real workflow people want (e.g. importing just a few pads from
  a factory kit into a kit already in progress).
