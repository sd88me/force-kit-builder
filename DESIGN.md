# Force Kit Builder — design

A web-based drum-kit builder for the Akai Force running MockbaMod — keeping
only Akai MPC `.xpm` export written directly to the Force's own local disk,
and replacing any on-device hardware-button UI entirely with a browser UI
shaped like a 16-pad grid.

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

## Module overview

The `core/*.mjs` modules are written as "pure modules" — no host-specific
shims baked into the actual logic, host access injected by the caller —
which keeps them small and easy to test in isolation:

| Module | Notes |
|---|---|
| `kit_model.mjs` | No `sample.ableton_uri` field and no fixed two-library `source` split — `sample.source` is a free-text label (the root folder path it came from). |
| `sample_classifier.mjs` | The 22-category folder/filename classifier has zero platform dependency. |
| `random_assign.mjs` | `source` is either an exact root-folder path, or `'all'`/omitted for no filter — see `bucketByRole()`'s doc. |
| `scan_filters.mjs` | Two opt-in filters (skip-loops, max-size) applied while the sample index is built. |
| `sample_index.mjs` | Plain Node `fs`. `sample_roots: string[]` — an arbitrary, user-picked list of folders. No URI-scheme concept anywhere in this data model. |
| `storage.mjs` | Plain Node `fs`. Only the MPC `.xpm` exporter exists here (no other preset export path). No SSH-push-to-device subsystem — moot once the tool *is* the Force. |
| `loudness.mjs` | Pure math — attenuate-only gain matching from a set of loudness readings. |
| `wav_info.mjs` | `fs.readFileSync()` returns a real `Buffer` directly, so there's no base64 round-trip needed anywhere in this pipeline. |
| `wav_rms.mjs` | Reads each pad's own WAV file directly and computes RMS server-side in Node — no Web Audio, no browser round-trip, fully headless. |
| `validation.mjs` | `application: 'force-kit-builder'`. |
| `exporters/mpc_xpm.mjs` | `opts.dir` is **required**, never defaulted inside this module. See "Export destination" below for why. |
| `exporters/xpm_template.mjs` | Pure XML/JSON template data lifted from a real MPC-V 2.1 drum program. |

**Explicitly not part of this project**: any other preset/rack export format
(this port is XPM-only by design), an SSH-push-to-device transfer step
(moot — the tool runs natively on the Force), a native sample-audition
player (a browser can audition samples trivially via `<audio>` hitting a
streaming endpoint), and any on-device hardware-button/touchscreen control
path — only the *actions* a hardware UI would orchestrate (Assign, Clear,
Unlock All, Save, Rescan, reroll one pad, reject/favourite, Match Levels,
Export) are the reusable contract; the web UI calls the same core modules
those actions would have called.

## Data model

A kit is 16 pads:

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
other`), classified by folder path (deepest match wins) with a
filename-token fallback when the folder yields nothing. `glitch` (aliases:
`glitch`, `glitches`, `glitchy`, `grain`, `grains`, `granular`) was split off
`fx` (which used to also claim `glitch`/`glitches` before
`buildAliasIndex()`'s first-writer-wins rule made that ambiguous) as its own
category, added after this project's initial build. It has no dedicated pad
slot, so — like every other unslotted category — it falls into pads 13-16's
catch-all pool automatically via `random_assign.mjs`'s `otherPoolCats()`, and
into the SYSTEM status panel's "Other" line automatically via
`sample_index.mjs`'s `summarize()` (neither needed a code change beyond
adding the category itself; that's the payoff of those two functions
computing "everything not explicitly slotted" instead of a fixed list).

Each of the 16 pads draws from a **union** of one or more categories
(`pad_layout`); pad 12 is always `fx`, pads 13–16 are a sentinel that expands
to every category with no dedicated slot plus `fx`. See
`core/sample_classifier.mjs` and `core/sample_index.mjs`'s
`DEFAULT_CONFIG.role_rules`/`pad_layout` for the full vocabulary.

**Per-pad pool picker**: each pad tile has a dropdown letting you pick a
single category to override that pad's pool. This writes to
`config.pad_layout[pad]` via `storage.savePadLayoutEntry()` — config-wide,
not per-kit: it changes which pool that pad slot draws from for every future
Assign/Reroll, on any kit, until changed again.

## Lock / reject / favourite

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
**silence on real Akai Force hardware** (confirmed on hardware) — so every
assigned pad's `SliceEnd` must be set to
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
  buttons, click-to-audition, a small waveform preview (see below), and a
  border/background state that mirrors the original hardware's LED priority
  (missing → locked → assigned → empty).
- **Pad detail panel**: gain slider (dB readout), a larger waveform preview
  (see below), reroll/clear buttons, library-wide fav/reject counts.
- **Toolbar**: New, Assign, Clear, Unlock All, Match Levels, Save, Load XPM…,
  duplicate-avoidance toggle.
- **Source panel**: selected root folders (add via the file-browser modal,
  which calls nodeServer's own `/file-browser/LIST`), scan filters
  (skip-loops, max-size), Rescan, live index summary.
- **Export panel**: kit name, destination folder (same file-browser modal),
  Export button, warnings/manifest summary.

## Waveform preview

Shown in two places, sharing one implementation: a small canvas on every
assigned pad tile (in the tile's flexible middle space, between the pool
`<select>` and the filename), and a larger one in the pad-detail side panel
for whichever pad is currently selected. Per-pad-only was the original v1
scope; per-pad-tile was added on request once the side-panel version proved
the approach — the earlier "16 canvases is wasteful" concern is addressed by
caching (below), not by avoiding the per-pad case.

**Peaks are computed server-side**, not client-side. The first version of
this feature decoded audio in the browser via the Web Audio API's
`decodeAudioData()` — this was a real bug, not a hypothetical: that API is
strict about "valid" WAV shapes and was silently rejecting real sample-pack
content (24-bit PCM, extended `fmt ` headers, BWF/broadcast metadata chunks)
that's perfectly well-formed, so some pads simply showed no waveform at all
with no visible error. Fixed by reusing this project's own hand-rolled,
permissive WAV parser — `core/wav_peaks.mjs`, a companion to `wav_rms.mjs`
(same `wavChunks()` parser, same 8/16/24/32-bit-int + 32-bit-float support
matrix) — behind a new `PEAKS` action (`GET /kit-builder/PEAKS/<encoded
path>`, same `knownPaths()` trust gate as `AUDIO`), returning a fixed
128-bucket `{min,max}[]` as JSON. `client.js` just fetches and paints; no
audio decoding happens in the browser at all any more.

Peaks are cached client-side by `filesystem_path` (`waveformCache`), shared
across both the pad-tile and side-panel canvases, so a kit with the same
sample assigned to two pads (or a re-render after an unrelated action
rebuilding the whole grid) only fetches each unique sample's peaks once. A
server-confirmed `null` (a file the parser couldn't read) is cached too —
`waveformCache.has()`, not truthiness, is the check — specifically so an
unsupported file doesn't get re-requested on every single re-render; a
network/parse failure on the fetch itself is deliberately left uncached,
since that might be transient and is worth retrying next render.

`paintWaveform()` maps each canvas pixel column to a peaks index by
proportion (`x * peaks.length / canvas.width`), not a 1:1 index-to-pixel
assumption. This fixes a second latent bug from the original client-decode
version: peaks are always exactly 128 entries now, but even before this fix,
whenever a cached result's original resolution didn't match a canvas's own
width (e.g. a 110px pad tile vs. a 260px side panel, or simply because two
differently-sized canvases shared one cache entry), the old 1:1 loop would
silently draw only the left portion of the waveform, squished, rather than
scaling to fill the canvas.

Every canvas is a fresh DOM element created on each render (`renderGrid()`/
`renderPadDetail()` rebuild their containers from scratch), so the one race
worth guarding — a slow fetch resolving after a newer render already
replaced that pad's tile — is handled with a plain `canvas.isConnected`
check before painting: painting into a detached canvas would be invisible
anyway, and a per-canvas check is correct regardless of how many are in
flight at once (a shared monotonic token, used in the original version,
would incorrectly invalidate other pads' in-flight fetches the moment any
one pad re-rendered).

## Explicitly out of scope for this version

- Ableton `.ablpreset`/MrDrums export (the whole point of this port is
  XPM-only).
- The SSH "send to Force" push — moot, this *is* the Force.
- A step-sequencer/pattern-audition page — flagged as a later-phase feature,
  not part of this version.
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

- **Test-harness circular import bug**: an earlier version of `tests/run.js`
  put `assert`/`eq` directly in itself, and every `test_*.js` imported them
  back from `run.js` — a circular import between an async (top-level-`await`)
  module and its own dynamically imported children. This deadlocks on Node 20
  (`process.exit(13)`, "unsettled top-level await", with **zero output**, no
  error message at all — it took real effort to track down). Fixed here by
  moving `assert`/`eq` into their own dependency-free `tests/assert.js`.
- **`SET_POOL` is a new action** — pad-pool reassignment wasn't previously
  exposed as an interactive control; it lived only in on-disk config, edited
  by hand. Making it "selectable on the pad" was an explicit ask for this
  version.
- **`wav_rms.mjs` RMS is over the whole sample**, not a peak-window RMS —
  good enough for the attenuate-only relative ranking `loudness.mjs`'s
  `matchGains()` needs, not a broadcast-accurate loudness measurement.
  Revisit if that distinction ever matters.
- **No per-kit pool overrides** — `SET_POOL` is config-wide, not stored on
  the kit document itself. If a
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

## v2 scoping: standalone on-device addon with a shadow GUI (not yet built)

"Any hardware-button/on-device-GUI control path at all" was explicitly out
of scope for the version above. This section scopes reversing that — a real
MockbaMod addon (`ForceKitBuilder`) that renders a touchscreen page via
`force-shadow`, **alongside** the existing nodeServer web plugin, not
replacing it. Decided 2026-09-21, not yet implemented — this is the plan to
pick up when building it, same role as force-shadow's own old "RESUME HERE"
section played before that project shipped.

### Why alongside, not instead

The web plugin stays the full-detail surface: source-folder/export-folder
pickers (via nodeServer's `/file-browser/LIST`), per-pad pool
reassignment, category tuning, waveform preview, XPM import. A touchscreen
page has nowhere to put a file-path text field or a fine-grained pool
editor with any real usability — trying to cram that in would make the
shadow page worse at its job (fast, physical, no-laptop-needed kit
iteration) without actually replacing the web UI's, so both stay.

### Key finding: they already share state for free

`core/storage.mjs` is the **only** thing that reads/writes
`current-kit.json` and `preferences.json` under `KB_DIR`. The nodeServer
plugin doesn't own that state — it just calls into `storage.mjs` like any
other caller. That means a new on-device daemon that also imports
`core/storage.mjs` (and `kit_model.mjs`, `random_assign.mjs`,
`sample_classifier.mjs`, `exporters/mpc_xpm.mjs` — the same modules the
plugin already uses, unmodified, straight from this repo) is *automatically*
looking at the same working kit and the same source/export-folder prefs the
web UI set — no new sync mechanism to design or maintain. Generate a kit on
the touchscreen, open the web UI, see the same kit; either surface's
`EXPORT` writes the same `current-kit.json` the other would read next.

This is also the direct answer to "can they both share the same core code
so I don't have to maintain both": yes, literally the same `core/` and
`exporters/` directories, imported by two different front ends. Nothing
about the core layer is nodeServer-specific already (see the "Architecture"
section above — it's plain ES modules with no browser/HTTP assumptions
baked in), which is exactly what makes this cheap.

### Architecture

New addon folder, `AddOns/ForceKitBuilder/`, alongside this repo's existing
`core/`/`exporters/` (deployed either as a git submodule-style copy at
install time, or a relative import if colocated — decide at build time, not
a design blocker):

- `manage.sh`, `run_forcekitbuilder.sh` — standard MockbaMod addon
  contract (`references/architecture.md` in the `mockbamod-module-creator`
  skill has the exact shape).
- `host/daemon.mjs` — a small Node process (Node's already on-device via
  the nodeServer AddOn) that:
  - Listens on a Unix control socket at `/tmp/kitbuilder_ctrl.sock`
    (matches the `/tmp/<addon>_ctrl.sock` convention `force-dx7`/
    `force-maze` already use), speaking the plain
    `SET <key> <value>\n -> OK\n|ERR\n` / `GET <key>\n -> <value>\n`
    protocol every other shadow-GUI-backed addon uses (confirmed identical
    across addons per `force-shadow/docs/adding-a-page.md`).
  - Imports `core/storage.mjs`, `core/kit_model.mjs`,
    `core/random_assign.mjs`, `core/sample_classifier.mjs`,
    `exporters/mpc_xpm.mjs` directly — the daemon is a thin protocol
    adapter, not a reimplementation. Same division of labour as
    `plugin/api/endpoints/kitbuilder/index.js`, just a Unix-socket
    frontend instead of an HTTP one.
  - **No `engine_process_name` block in `shadow_page.conf`** — Kit Builder
    isn't a continuous DSP engine with an audio on/off state, so there's no
    on/off button to draw. The daemon can just run at boot like any other
    lightweight background addon (idle until a `SET`/`GET` arrives, no
    meaningful resource cost).
  - Source/export folders: **read-only from the daemon's side** — it reads
    whatever `preferences.json` already holds (set via the web UI's
    pickers), not its own copy. If nothing's configured yet,
    `GET status` should say so plainly rather than silently no-op, so the
    touchscreen page can show a "set source/export folders in the web UI
    first" message instead of a confusing empty grid.

### Control protocol (v1 — core loop only)

| key | direction | meaning |
|---|---|---|
| `pads` | GET | JSON array of 16 `{label, name}` — `label` = sample filename (or "empty"), `name` = category, for the pad-grid `list` widget |
| `pad_sel` | GET/SET | currently selected pad index (0-15); `SET` both selects *and* is what the `list` widget's tap sends |
| `pad_info` | GET | one-line text for the selected pad (full sample name + category + source pool) — feeds a `readout` |
| `pad_lock` | GET/SET | lock state (0/1) of the selected pad — `bits`/`toggle` widget |
| `generate` | SET | regenerate all unlocked pads (calls `random_assign`'s existing logic, same as the web UI's `ASSIGN` action) |
| `reassign_pad` | SET | reassign just the selected pad, respecting its lock state (should be a no-op / `ERR` if locked) |
| `export` | SET | write the current kit to the configured export folder (same `exportMpcXpm()` call the web `EXPORT` action makes) |
| `status` | GET | last operation's result message, or a "not configured yet" notice — feeds a `readout` |

### Shadow page layout (single tab, v1)

The `list` widget's `cols=`/`rows=` grid is a direct fit for the 16-pad
layout — no need for 16 separate widgets. Modeled on `force-dx7`'s
existing two-`list` page (`force-dx7/addon/shadow_page.conf:238-240`) as
the closest real precedent for "tappable grid + detail readout":

```
[tab Kit]
frame   x=36 y=36 w=724 h=900 title="PADS"
list    x=52 y=88 w=692 h=848 key=pad_sel items=pads sel=pad_sel \
        cols=4 rows=4 th=150 gap=12 jump=0 colmajor=0 numbered=1 scale=2
frame   x=776 y=36 w=468 h=900 title="SELECTED PAD"
readout x=792 y=88 w=436 h=120 label="" get=pad_info
toggle  cx=850 cy=260 label="Lock" key=pad_lock
button  cx=850 cy=340 label="Reassign" key=reassign_pad
button  cx=850 cy=460 label="Generate All" key=generate
button  cx=850 cy=580 label="Export Kit" key=export
readout x=792 y=680 w=436 h=180 label="" get=status
```

Coordinates are a first pass, not measured against a real render — verify
with `force-shadow`'s offline PPM/PNG harness (`force-device-workflow`
skill) before touching the device, same as every other page in this
family.

### Open items before implementation

- [ ] Confirm exact `KB_DIR` path resolution works identically from the new
      daemon's install location as it does from inside nodeServer's process
      (should — `sample_index.mjs`'s `KB_DIR` doesn't appear to depend on
      `__dirname`, but verify, not assume).
- [ ] Decide how `core/`/`exporters/` physically get onto the device for
      the addon to `import` — a copy step in `install.sh`/the addon's own
      install, or restructuring this repo so both the nodeServer plugin
      and the new addon reference one on-disk copy. Either is fine
      functionally; pick whichever keeps a version-skew mistake (addon and
      plugin importing different copies of `storage.mjs` after only one
      gets redeployed) hardest to make by accident.
- [ ] `reassign_pad` on a locked pad: silently no-op, or `ERR` so the
      shadow-GUI renderer can flash/reject the tap? Check how other addons'
      control sockets signal "rejected, but not a real error."
- [ ] Render and eyeball-check the layout above with the offline PPM
      harness before any live-device test.
- [ ] Decide the addon's boot-loop entry shape for a process with no
      continuous audio/MIDI responsibility — closest precedent needed
      (probably still just a plain background process + `run_*.sh`, per
      `references/architecture.md`, but confirm rather than assume it needs
      nothing special just because it's "only" a control-socket listener).
