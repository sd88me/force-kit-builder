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

### Open items — resolved, v1 implemented (2026-09-21)

- [x] **`KB_DIR` resolution**: confirmed by reading `sample_index.mjs` —
      `KB_DIR` has no `__dirname` dependency, it's whatever
      `configureDataDir()` was last called with. The daemon calls it with
      the exact same path nodeServer's plugin does
      (`<mmPath>/AddOns/nodeServer/app/kitbuilder-core/data`), so both
      processes share one data directory automatically.
- [x] **How `core`/`exporters` get onto the device**: resolved by *not*
      copying them at all — the daemon imports directly from nodeServer's
      already-installed `kitbuilder-core/`
      (`addon/host/daemon.mjs`'s `resolveNodeServerAppDir()`). One copy on
      disk, imported by two processes; the version-skew risk the open item
      worried about doesn't exist because there's nothing to skew. Real
      cost: Kit Builder's shadow GUI now hard-depends on the FORCE-APPS-
      SERVER-MOCKBA fork's Kit Builder being installed first, on top of
      the nodeServer dependency the "Architecture" section above already
      accepted.
- [x] **Locked-pad `reassign_pad`**: `core/random_assign.mjs`'s
      `rerollPad()` already returns `{changed:false, warning:'pad is
      locked'}` rather than throwing — the daemon replies `OK <warning
      text>`, not `ERR`, and surfaces it via the `status` readout. Verified
      in the offline socket test below.
- [x] **Boot-loop entry shape**: plain background process, standard
      `manage.sh`/`run_forcekitbuilder.sh` contract per
      `references/architecture.md` — no LD_PRELOAD, no `acvs` restart, no
      `NSMODULE.json`/Modules Manager entry (there's no on/off engine
      state to manage). `run_forcekitbuilder.sh`'s `kill` handler greps the
      process list for `daemon.mjs` specifically rather than `killall
      node`, which would also take down nodeServer itself.
- [ ] **Offline visual render before ever touching the device**: turned
      out to be a false assumption in the original scoping —
      `force-shadow/tools/render_preview.c` is hardcoded to Maze Voice's
      own page, not a generic `.conf` renderer, so there is currently no
      way to actually see this layout rendered without either extending
      that tool or looking at the real device. The coordinates below are
      hand-checked against the real 1280x800 landscape canvas
      (`LAND_W`/`LAND_H` in that file) so nothing overflows the bounds,
      but exact spacing/overlap is unverified until a real look — first
      `SHIFT+SCENE-1` on the device should be treated as the actual layout
      review, not a formality.

### v1 implementation notes

- `addon/host/daemon.mjs` re-reads `current-kit.json` from disk on every
  request (`syncKit()`), not just at startup — the web plugin and this
  daemon each hold their own in-memory copy, so without this the shadow
  page could show a stale kit after the web UI generates/edits one.
  `index`/prefs are *not* re-synced per-request (only via `RESCAN`/export
  from the web UI, infrequent enough that startup-load is an acceptable v1
  limitation — revisit if that assumption turns out wrong in practice).
- **No persisted export destination existed before this** — the web UI's
  `EXPORT` action took `destDir` fresh on every call, nothing saved to
  `preferences.json`. Added `last_export_dir` to `loadPrefs()`/
  `savePrefs()` (`core/storage.mjs`) plus a `persistPrefs()` helper in the
  nodeServer endpoint that always threads it through — `savePrefs()`
  replaces the whole file each call, so any call site that forgot to pass
  it would have silently erased a previously-saved value; there's now
  exactly one call site to get that right instead of several. The daemon
  reads this value but never writes it — no folder picker on a
  touchscreen, so "export once from the web UI to set the destination,
  then the shadow page can re-export there" is the intended flow.
- Verified offline end-to-end in Docker (`node:20-slim`, no device
  needed) before writing a line of `shadow_page.conf`: a fake `mmPath`
  tree with synthetic WAV fixtures and a hand-built sample index, the
  daemon started for real, a raw socket client scripted through
  `GET pads` → `SET generate` (hit the real "duplicates allowed" warning
  path) → lock → `SET reassign_pad` on both a locked and unlocked pad →
  `SET export` (both the "no dir configured" `ERR` path and, with
  `preferences.json` seeded, a real `.xpm` + `MANIFEST.txt` + gathered
  WAVs written to disk and confirmed present). This is what caught the
  `h=900` frame overflowing the 800px canvas height in the first
  `shadow_page.conf` draft, and confirmed the locked-pad path replies
  `OK`, not `ERR`, as designed.
- Full `tests/run.js` suite (104 cases after adding `last_export_dir`
  coverage) still passes — `docker run --rm -v $(pwd):/app -w /app
  node:20-slim node tests/run.js`.

### Still not done

- Not yet deployed to or tested on the real device — SSH access to a
  MockbaMod Force wasn't available in the environment this was built in.
  Deploy via the usual staged-copy pattern
  (`force-device-workflow` skill), enable via `manage.sh ENABLE`, then
  work through the verification checklist in
  `mockbamod-module-creator`'s `references/architecture.md` (process
  runs, survives a real reboot, etc.) before trusting it live.
- No favourite/reject controls on the shadow page (v1 is intentionally
  core-loop-only, per the original scoping decision) — `core/storage.mjs`'s
  `last_export_dir` plumbing was written generically enough that adding
  more prefs fields later doesn't need another `persistPrefs()`-style
  refactor.
- ~~`render_preview.c` only covers Maze Voice~~ — resolved upstream:
  `force-shadow/tools/render_conf_preview.c` is now a real generic
  `.conf` preview tool (`style=td3`/`theme_*` aware, every widget kind).
  Used below to render `shadow_page.conf` after applying the `td3` theme
  and catching a font-safety bug — see "v2 refinements" below.

## v2 refinements: td3 theme, font-safety (2026-09-22)

Applied `mockbamod-module-creator`'s new default-theme guidance
(`style=td3`, `force-acid`'s own palette copied verbatim) and rendered
with `force-shadow/tools/render_conf_preview` before touching anything
live:

- **Real bug caught by the render**: every button/toggle label
  (`Lock`, `Reassign`, `Generate All`, `Export Kit`) was mixed-case.
  `force-shadow`'s baked font (`src/font8x8.h`) only has glyphs for
  space, `A-Z` (uppercase only), `0-9`, and `. - / > % + :` — anything
  else silently renders as a blank gap, not an error. Fixed the static
  labels in `shadow_page.conf` to all-caps, and added a
  `shadowFontSafe()` sanitizer in `daemon.mjs` for every *dynamic*
  string sent over the control socket (`pad_info`, pad labels, `status`)
  — real sample filenames like `Moombahton-Kick-MB Kick 14.WAV` have
  lowercase letters that would otherwise vanish. `pads`'s JSON payload
  is sanitized per-field inside `padsJson()`/`padLabel()`, not as a
  blanket string filter, since blanket-filtering would corrupt the JSON
  syntax itself (braces/quotes/commas aren't in the allowed charset).
- The render tool's `list` widget always shows its own hardcoded
  `force-webstream` fixture data (`"01 YOUTUB"`, `"03 SOUNDC"`, …) —
  it has no live daemon to query `GET pads` from, so this is expected,
  not a bug; the real device will show the 16 real pads.
- A small black box + garbled text renders top-left, unrelated to
  anything in this `.conf` — confirmed by swapping `display_name` to
  distinct test text and re-rendering: the artifact didn't move or
  change. **Correction (see "Per-pad control redesign" below): this was
  wrong.** It was one of this page's own `readout` widgets, drawn near
  `(0,0)` and clipped by the canvas edge, because `readout` takes
  `cx=`/`cy=` (center point) and this draft used `x=`/`y=` (top-left) —
  swapping the *label* didn't move it because the bug wasn't in the
  label, it was in the coordinates. Confirmed by checking
  `force-shadow/src/force_shadow.c`'s real parser, not just the preview
  tool's copy of the same logic, and confirmed gone once every `readout`
  in this file was fixed to `cx=`/`cy=`.

## Per-pad control redesign + Akai OS-style theme (2026-09-22)

Reworked per this project's own direction: bigger pads, each pad's own
LOCK/REROLL/CLEAR controls directly on the pad instead of a shared
"selected pad" side panel + tap-to-select grid, a GLOBAL tab for
kit-wide actions (GENERATE ALL, CLEAR ALL, NORMALISE, EXPORT KIT), and a
dark/cyan colour scheme approximating the Akai Force's own OS look
rather than `force-acid`'s yellow `td3` palette (kept `style=td3`'s
proven widget *shapes* — rounded frames, pill buttons — only the
`theme_*` colour values changed). **No verified reference for the real
Force OS's exact colours exists in this repo family yet** — these hex
values are a reasonable starting approximation (dark charcoal panels,
cyan selection/accent, neutral grey buttons), not confirmed-correct;
compare against the real hardware and adjust once possible.

### Why two pad tabs, not one

16 pads × (frame + readout + toggle + 2 buttons) = 80 widgets — over the
format's 64-widgets-per-tab cap (`docs/adding-a-page.md`: "up to 8 tabs,
64 widgets per tab"). Split into "PADS 1-8" / "PADS 9-16" (8 × 5 = 40
widgets each, comfortable headroom) plus a separate "GLOBAL" tab for the
kit-wide actions. This also delivers the "bigger pads" ask directly —
each pad now gets a full ~610×150 cell (2 columns × 4 rows) instead of a
~140px grid tile, room to show the complete sample filename instead of a
truncated one.

### Protocol redesign: per-pad-indexed keys, no shared selection state

v1's protocol had one `pad_sel` + `pad_info`/`pad_lock` triple driving a
tap-to-select `list` widget. Since every pad now has its own controls
directly, there's no "currently selected pad" concept left — replaced
with per-pad-indexed keys instead: `pad_info_N`, `pad_lock_N` (GET/SET),
`reroll_pad_N` (SET), `clear_pad_N` (SET), `pad_path_N` (GET, raw, for
the future C++ preview producer — see v3 below), for `N` in `0..15`.
`daemon.mjs` matches these with one regex
(`/^(pad_info|pad_lock|pad_path|reroll_pad|clear_pad)_(\d+)$/`) rather
than 80 individual `switch` cases. Also added: `clear_all` (SET, wraps
`core/kit_model.mjs`'s existing `clearUnlocked()`) and `normalize` (SET,
ports the web plugin's existing `MATCH_LEVELS` action — same
`core/loudness.mjs` `matchGains()` + `core/wav_rms.mjs` call, just
daemon-side instead of nodeServer-side. Both already-proven core
functions, not new logic).

### Real bug the render caught: `readout`'s `cx`/`cy`, not `x`/`y`

Confirmed against `force-shadow/src/force_shadow.c`'s real conf parser
(not just the preview tool's copy of the same logic, though both agree):
`frame` and `list` read their own `x=`/`y=` keys (top-left corner).
**Every other widget kind — `readout`, `toggle`, `button`, `knob`,
`stepper`, `enum_h`/`enum_v` — reads `cx=`/`cy=` (center point)
instead.** The first draft of this redesign used `x=`/`y=` on every
`readout` line, matching the mental model from `frame`/`list` just above
them in the same file. This doesn't error — it silently computes
`x0 = 0 - w/2`, `y0 = 0 - h/2` (since `cx`/`cy` default to 0 when absent)
and draws mostly off-canvas, with just a clipped corner visible. This is
exactly the artifact wrongly blamed on the preview tool in "v2
refinements" above. Fixed by regenerating every `readout` line with the
correct center-point math.

### Generated, not hand-written

16 near-identical pad blocks is exactly the kind of thing hand-editing
gets subtly wrong (this file's own history is the proof). `shadow_page.conf`
is now generated by `tools/gen_shadow_page.py` — edit the script and
regenerate (`python3 tools/gen_shadow_page.py addon/shadow_page.conf`)
rather than hand-editing the pad blocks directly.

### Colour: cyan → orange (2026-09-22, same day)

`theme_accent`/`theme_accent_hi`/`theme_seg_active` changed from cyan
(`00b8d4`/`4dd0e1`) to orange (`ff8f00`/`ffb74d`) — the rest of the
Akai-OS-approximation palette (dark charcoal panels/buttons) is
unchanged. Also made `padInfoText()` always prefix the pad number
(`daemon.mjs`) rather than relying solely on each pad's frame title to
show it — needed for the one-tab layout explored next, harmless
alongside the frame title in the layout that's actually in use.

### Explored and rejected: all 16 pads on one tab

Asked whether 16 pads could fit on a single tab instead of two.
Technically yes — `readout + toggle + 2 buttons` × 16 = exactly 64
widgets, the format's own per-tab cap, with a 4-column × 4-row grid and
no per-pad `frame` (no widget budget left for one). Built as
`tools/gen_shadow_page.py --one-page` and rendered to check before
deciding either way, not just estimated from the numbers. The render
showed a real, not just aesthetic, regression: button pills auto-size to
their label text (`render_conf_preview.c`'s `widget_button`), and at
this cell width **REROLL's pill overlaps CLEAR's and gets visually
clipped to "REROL"** — a genuine touch-target/legibility problem on
hardware where tap accuracy is the whole point, not a style preference.
Compared side-by-side, kept the two-tab layout (8 pads/tab). The
`--one-page` generator path is kept in the script since the comparison
render is what settled this, not a guess — worth being able to
regenerate and re-check if the per-pad control count ever shrinks enough
to make it viable again.

### Status readout moved to the top bar (2026-09-22, same day)

Was a large box at the bottom of just the GLOBAL tab; moved to the top
bar (`cy=36`, inside `TOPBAR_H`'s 72px) instead, repeated on every tab -
same pattern `force-dx7/addon/shadow_page.conf` already uses for its
bank-name readout. Two real findings behind this, not just taste:

- We have no `engine_process_name` block, so on the *real* device (not
  the preview tool, which always draws its own placeholder pill
  regardless of the `.conf`) the whole top-right of the bar is empty -
  free real estate, not a space we'd be fighting the renderer for.
- Putting status only on GLOBAL meant switching tabs to see it. On the
  top bar it's visible from any pad tab too - e.g. "Pad 3 reassigned"
  shows immediately without leaving the pads you're working on.

Freed the bottom of GLOBAL up for the four action buttons to use the
full tab height instead of being packed into the top half.

### Pools, categories, buckets — asked to clarify, already distinct

`core/sample_index.mjs`'s `ROLE_ORDER` (23 raw classification
categories: `kick`, `snare`, `hat`, `crash`, `vox`, `synth`, …) is not
the same thing as `SYSTEM_BUCKETS` (8: Kick/Snr/Clap/Hats/Tom/Perc/Cym/
FX) — buckets are a **display-only** grouping for the web UI's sample-
count summary panel, not currently wired to pool assignment at all. A
pad's actual **pool** (`pad_layout` config entry, written by the web
UI's `SET_POOL` action / `core/storage.mjs`'s `savePadLayoutEntry()`) is
an array of 1+ raw *categories*, config-wide (not per-kit) — see
`DEFAULT_PAD_LAYOUT` in `core/kit_model.mjs` for the 16 defaults.

Asked whether pool selectors could fit on the shadow page: not cleanly.
23 categories is well over `enum_h`/`enum_v`'s 6-option cap, there's no
multi-select widget in the format at all (a pool is a *set* of
categories, not one pick), and repurposing the 8 display buckets for
this would still be 2 over the cap and would change what "pool" means
(restricting each pad to one bucket rather than a free category
combination) — a real product decision, not made here. Left as web-UI-
only, per the original "Why alongside, not instead" reasoning above; not
revisited further without a decision on that tradeoff.

### Verified before deploying

- All three tabs rendered with `force-shadow/tools/render_conf_preview`
  and eyeballed — correct dark charcoal / orange theme, all labels
  legible (uppercase, font-safe), `readout` text visible in the right
  place, no stray
  artifacts.
- `daemon.mjs` re-tested end-to-end offline (Docker, synthetic WAV
  fixtures, same harness as v1): `pad_info_N`/`pad_lock_N` per-pad,
  `reroll_pad_N` on both a locked pad (correctly refuses, `OK` not `ERR`)
  and one that happens to re-pick its existing sample (a real, distinct
  case from "locked" — the status message used to wrongly imply
  "locked?" for this case too; fixed to say "same sample re-picked"),
  `clear_pad_N` (respects lock, refuses on a locked pad same as reroll),
  `clear_all` (respects locks, only clears unlocked pads), `normalize`
  (runs with and without samples present).
- Full `tests/run.js` suite (104 cases, unaffected — this redesign didn't
  touch `core/`) still passes.
- **Not yet deployed to or re-tested on the real device** — same
  limitation as v1's own "Still not done": no SSH access to a MockbaMod
  Force in this environment while this was built. Re-run the same
  deploy/verify checklist before trusting it live, since the whole
  protocol changed, not just cosmetics.

## v3 scoping: audible sample preview via note keys (not yet built)

Asked 2026-09-22: can pads be previewed audibly, ideally by hitting the
Force's own physical pads (notes 36-51, matching `PAD_MIDI_NOTES`) like a
normal drum kit, before ever exporting? Answer: yes — this reuses
`force-audioin`'s existing shared-memory-ring injection mechanism rather
than inventing new `LD_PRELOAD` code, the same way every other
sample-triggered voice in this family (Maze Voice, DX7, JV-880) already
gets audio into the Force's mix. Not yet implemented; this is the plan to
build from, in the same spirit as the v2 addon's own scoping section
above.

### Why a separate process, not the existing daemon

`force-audioin/DESIGN.md`'s "Building a new voice producer" section is
explicit: **a producer must be started only via its own
`NSMODULE.json`/Modules Manager entry — never from an addon's own boot
script — and never while `acvs` is about to restart** (the same hard rule
`force-device-workflow` already enforces for `force-audioin`/Maze). The
existing `addon/host/daemon.mjs` is deliberately always-on from boot
(no continuous-engine state to manage, per the v2 scoping) — bolting
audio production onto it would violate that rule the moment someone
restarts `acvs` with a preview mid-hit. So this is a **second, separate
process** (`addon/host/preview` — name pending), gated behind the
Modules Manager like `dx7_host`/`maze_host` are, `AUTOLAUNCHABLE: false`.

### Why native C++, not Node

Every existing producer (`injectTone.c`, `maze_host.cpp`, `dx7_host.cpp`)
is a native C/C++ binary using `shm_open`/`mmap` directly against
`ai_shm_t`'s exact struct layout (`force-audioin/src/forceAudioInject.h`),
including a hand-rolled SPSC ring with specific acquire/release memory-
ordering semantics on the `head`/`tail` fields. Node has no built-in POSIX
shared-memory/mmap binding, and this device has no working path to add
one (no npm registry access, no on-device compiler for a native addon —
see `mockbamod-module-creator` skill's cross-compile-via-Docker+QEMU
convention every native piece in this family already uses). Matching
existing precedent exactly — vendor `forceAudioInject.h` byte-for-byte,
write a small C++ binary, cross-compile the same way `force-shadow`'s
`.so` and `force-dx7`'s `dx7_host` already do — is both lower-risk and
less new surface area than trying to be the first Node producer in this
family.

### MIDI input: reuse the family's own established pattern, don't invent one

`force-maze/maze-voice/src/maze_host.cpp` already solves "receive note
input from a Force pad/track" — `RtMidiIn::openVirtualPort("In (Mockba)")`
+ `setCallback()`, vendored `rtmidi/RtMidi.h` (already present in this
family's other repos, e.g. `force-maze/maze-voice/src/rtmidi/`). This is
the standard MPC workflow: the user routes a track's MIDI output to the
new virtual port ("KIT BUILDER PREVIEW" or similar) the same way they'd
route to any external instrument — physically hitting that track's pads
then sends real note-on messages (0x90, note, velocity) to our producer.
**This is not a passive tap of raw physical pad hits** — nothing in this
family intercepts those directly; every existing voice addon works this
same routed-track way, so this isn't a new UX pattern for anyone already
using Maze Voice or DX7 on this device.

### Producer flow (v1: monophonic, last-note-wins)

1. `RtMidiIn` callback receives `0x90 <note> <velocity>`. Ignore anything
   outside `36..51` (matches `PAD_MIDI_NOTES`) and any note-off (`0x80`,
   or `0x90` with velocity 0).
2. `note - 36` = pad index. Open a short-lived connection to the
   *existing* `/tmp/kitbuilder_ctrl.sock` and ask for that pad's real
   file path — needs one new daemon protocol key (see below) rather than
   the C++ producer re-reading/parsing `current-kit.json` itself
   (`daemon.mjs` already owns that state correctly, including the
   per-request `syncKit()` freshness fix from v2 — no reason to duplicate
   that logic in C++).
3. Decode the WAV (from-scratch parse, same spirit as
   `core/wav_info.mjs`/`core/wav_peaks.mjs` but in C++ — 16-bit PCM
   mono/stereo covers the real sample library based on what's already
   been seen live: `Moombahton-Kick-MB Kick 14.WAV` etc.). Convert to
   interleaved float32 at a fixed declared rate — 44100 stereo is the
   simplest choice and matches `AI_MAX_CH`.
4. Write into `/forceAudioInject3` (see slot accounting below) — resets
   `head`/writes fresh samples on every note-on, so a fast re-hit cuts
   off whatever was still playing rather than layering (true polyphony —
   mixing multiple concurrently-playing pad hits in software before one
   ring write — is a real v2 extension, not v1; flagging so "why does a
   fast roll cut itself off" doesn't look like a bug later).
5. `enabled=1`, `gain` fixed at `1.0` for v1 (no per-pad level control
   yet — `playback.gain` already exists on the kit's own pad data model
   for the *exported* XPM; wiring that same value into the preview's
   `gain` field is an obvious v2 tie-in, not done here).

### Daemon protocol key: already exists

Originally scoped as a new `GET pad_path` needing a `SET pad_sel`
selection step first — moot now. The "per-pad control redesign" below
replaced the shared-selection protocol with per-pad-indexed keys
(`pad_info_N`, `pad_lock_N`, …), and added `GET pad_path_N` (raw, **not**
run through `shadowFontSafe()` — that sanitizer is display-only and would
corrupt a real filesystem path) as one of them — returns pad `N`'s
`sample.filesystem_path`, empty string if the pad has no sample. The C++
producer just does `GET pad_path_<note-36>` directly, no selection step
at all — simpler than what this section originally scoped.

### Ring slot: 3 (needs live confirmation)

Confirmed by grepping sibling repos' own source comments (not
guessed): `force-dx7/src/dx7_host.cpp`'s own comment states the
existing assignment — `0 = Maze Voice, 1 = JV-880, 2 = DX7`. Slot `3` is
the last of `AI_MAX_VOICES` (4) and appears unclaimed by anything in this
device's addon family as of this scoping — **but this device was
unreachable when writing this** (`ssh: connect to host 192.168.1.187
port 22: No route to host`, 2026-09-22), so confirm live
(`ls /dev/shm/forceAudioInject*` and cross-check every installed voice
addon's own `NSMODULE.json` `--mix-slot` argument) before building
against slot 3, the same way the v2 addon's `page=1` assumption turned
out wrong until checked against the real device.

### Real UX dependency, not a shortcut around it

Injected audio lands on `MPC`'s *capture* path — same as every other
voice in this family — so it's only actually audible if the current
Force project has an Audio-In track listening to it, same one-time
per-project setup Maze Voice/DX7 users already do. Not a new burden this
project introduces, just worth stating plainly rather than implying
"hit a pad, hear it" is fully automatic with zero project-side setup.

### Built (2026-09-22) — everything except real MIDI hardware I/O

- [x] **Folder shape**: `addon/host/preview_host.cpp`, alongside
      `daemon.mjs`, matching how DX7 keeps `dx7_host` and its other
      surfaces in one addon folder — decided rather than left open.
      `addon/host/rtmidi/` (vendored `RtMidi.h`/`.cpp`, copied from
      `force-dx7/src/rtmidi/`) and `addon/host/forceAudioInject.h`
      (vendored from `force-audioin`, byte-for-byte — noted in its own
      header that `force-dx7`'s vendored copy has since drifted out of
      date against the canonical, not this repo's problem to fix).
- [x] **`NSMODULE.json`**: written, `--ctrl-sock`/`--mix-slot` arguments,
      `AUTOLAUNCHABLE: false` per `force-audioin`'s hard rule.
- [x] **Build**: `scripts/Dockerfile` + `scripts/build_preview.sh`, exact
      recipe copied from `force-dx7/scripts/` (Debian bookworm, not the
      older `stretch` base — this Force's real ceiling is glibc 2.39 per
      that Dockerfile's own comment). Compiles clean to a real armhf
      binary (`ELF 32-bit LSB pie executable, ARM, EABI5`), zero warnings.
- [x] **WAV decode coverage**: from-scratch RIFF/WAVE parser (no existing
      precedent to port — `dx7_host.cpp`/`maze_host.cpp` are pure
      synthesis, neither reads sample files), verified via a
      `--test-decode <path>` self-test mode against synthetic fixtures
      covering every format claimed: 8/16/24/32-bit PCM, 32-bit float,
      mono and stereo, plus a 22050Hz file to check the resampler. All
      produced correct frame counts and plausible sample values (checked
      by hand against the known sine-wave fixture, not just "didn't
      crash"). Edge cases mirroring `tests/test_wav_info.js`'s coverage —
      truncated file, garbage/non-RIFF input, no `data` chunk — all fail
      cleanly (`DECODE_FAILED`, exit 1), no crash.
- [x] **Full pipeline, minus the actual MIDI event**: a `--test-full`
      self-test mode calls exactly what `on_midi_cb()` calls (ctrl-socket
      lookup → decode → resample → real ring write) directly. Bridged a
      real `daemon.mjs` (x86 Docker, the same offline-fixture harness v1/
      v2 used) with the real armhf `preview_host` binary (Docker + QEMU)
      over a shared bind-mounted `/tmp` so they could talk over the real
      Unix socket across two different container architectures — confirmed
      `GET pad_path_0` returns empty on an unassigned pad, then a real
      path after `SET generate`, then confirmed the full pipeline writes
      to a genuine `/forceAudioInject3` shared-memory segment (524344
      bytes — exactly `sizeof(ai_shm_t)` for `AI_RING_FRAMES=65536`
      frames × `AI_MAX_CH=2`, not a guessed number).

### Not tested — genuinely can't be, without the real device

- **Ring slot 3 is still not live-confirmed.** Same caveat as when this
  was first scoped — no SSH access to the device while this was built.
  `ls /dev/shm/forceAudioInject*` and cross-checking every installed
  voice addon's `NSMODULE.json` `--mix-slot` before trusting slot 3
  remains the first real step on-device, before even installing this.
- **Whether the injected audio is actually audible** depends on the
  current Force project having an Audio-In track routed to it (see
  "Real UX dependency, not a shortcut around it" above) — that's a
  device/project-state check, not something any of this offline testing
  could exercise.

## v3 revision: touchscreen PLAY button, not MIDI (2026-09-22, same day)

Asked directly: does the RtMidi virtual port need track routing set up
every time, or does it passively see whatever's already playing? Answer
was routing, always — `RtMidiIn::openVirtualPort()` registers a real,
separate ALSA sequencer client that shows up in MPC's own Track MIDI
In/Out dropdown; it can't see anything not explicitly routed to it, same
as Maze Voice/DX7/every other voice addon in this family. Explicitly
asked not to have that setup requirement.

Checked whether a passive tap of physical pad hits exists as a lower-risk
alternative before proposing anything: it doesn't, within this family's
established techniques. `sequencer-midi.md` confirms every voice-style
addon here (Maze Voice, DX7, Harpie4T, RiffMaker4T, Euclidier) uses the
same routed-virtual-port pattern; the "Private" MIDI port only carries
pad *LED colour* commands, one-directional, not note data. The only way
to actually intercept MPC's internal pad-note dispatch without a routed
track would be reverse-engineering and `LD_PRELOAD`-hooking MPC's
internal event handling — the same risk class as `mockbaMagic`'s raw
in-memory patching, `gotchas.md`'s own top-risk category. Not undertaken
for a preview *convenience* feature without that tradeoff being made
explicitly, not assumed.

**Resolution, proposed and chosen instead: a PLAY button per pad on the
shadow page itself.** This isn't a workaround, it's a real simplification
— removes the MIDI layer from this project entirely, not just the routing
step:

- `preview_host.cpp`: `RtMidiIn`, the vendored `rtmidi/` sources, and
  `on_midi_cb()` are gone. Replaced by `run_play_server()`, a small Unix-
  socket server (`--listen-sock`, default `/tmp/kitbuilder_preview_ctrl.sock`)
  speaking `PLAY <padIndex>\n` → `OK\n`/`ERR <msg>\n`. `play_pad()` is the
  exact same ctrl-lookup → decode → resample → ring-push logic
  `on_midi_cb()` used to call, just invoked from the socket handler
  instead of a MIDI callback — the part that was actually tested before
  (WAV decode, the full pipeline) is unchanged.
- **Build got simpler, not just different**: no RtMidi to compile/vendor,
  no `-lasound`, no ALSA dependency in `scripts/Dockerfile` at all anymore.
- `daemon.mjs`: new `SET play_pad_N` — since `shadow_page.conf` only has
  one `ctrl_sock` per page (pointed at `daemon.mjs`, unchanged), the PLAY
  button's tap arrives at the *daemon*, which relays `PLAY <n>` to
  `preview_host`'s listen socket and forwards the reply. `daemon.mjs`
  still never touches the shared-memory ring directly — it stays the
  always-on, boot-launched, audio-free process it already was; only
  `preview_host` (Modules-Manager-gated, never boot-launched) holds the
  ring, so `force-audioin`'s hard rule (never restart `acvs` with a voice
  attached) still can't be violated by a daemon that's always running.
  Fails gracefully (`ERR preview not running (ENOENT)`, not a crash) if
  `preview_host` hasn't been started from the Modules page yet.
- `shadow_page.conf`: fourth control per pad — LOCK/REROLL/CLEAR/PLAY,
  evenly spaced across the cell (checked by rendering, not just computed
  — see `gen_shadow_page.py`'s own comment on why that math gets checked
  every time now). 6 widgets/pad × 8 = 48/tab, still comfortably under
  the 64 cap.

**Verified**: the entire relay chain, for real, bridging three
processes across two container architectures — `daemon.mjs` (x86), the
real armhf `preview_host` binary (Docker/QEMU), and a tiny throwaway C
test client (since neither build environment had `nc`/`socat`/`python3`
available to improvise with). Confirmed: `SET play_pad_0` with no
`preview_host` running replies `ERR preview not running (ENOENT)`
(graceful, not a hang or crash); with `preview_host` running and a real
kit generated, `SET play_pad_0` on the daemon's socket produces a real
`preview_host` log line (`pad 1 -> /mm/Samples/kick_3.wav (4000 frames)`)
and a real ring write; an out-of-range pad (`play_pad_99`) is rejected by
`preview_host`'s own bounds check and the `ERR bad pad index` relays back
through the daemon correctly; a pad `generate` had already filled (no
longer-empty pads to test against, since `generate` fills every unlocked
pad) confirmed the `OK` path too. Full `tests/run.js` suite (104 cases,
unaffected by any of this) still passes.

**Still not tested**: the actual tap-to-PLAY round trip from a live
`force_shadow.c` render on real hardware — everything up to and including
the daemon relay is verified, but a real touchscreen tap dispatching that
`SET` is the one link this environment can't exercise. Ring slot 3 and
Audio-In track routing remain the same open items as before this
revision — unrelated to what changed here.

## Pool assignment page (2026-09-22, same day)

Picked up the "how would pool assignment even fit" question from the v2
refinements section above — the constraint there (23 categories, no
multi-select widget, `enum_h`/`enum_v` capped at 6 options) was correct,
but incomplete: it didn't yet know about `toggle`'s live `GET`-backed
state refresh, or that this family already has a working precedent for
exactly this shape.

**Precedent, not invented from scratch**: `EUCLIDIER-CONSOLE/addon/shadow_page.conf`
has a real 4×2 grid of individual `toggle` widgets (`rand_l1..rand_l8`,
its "which layers randomize" picker) — genuine multi-select, each toggle
independently on/off, confirmed live-tested in that project already.
That's the technique this page uses for categories: 23 individual
`toggle` widgets, not one attempt to cram them into a single wrong-shaped
widget. Confirmed `toggle` actually supports live state refresh (not just
a static `on=` set once at page load) by reading `force_shadow.c`'s own
poll loop — `W_TOGGLE`'s `GET <key>` result updates `w->state` every
cycle, same `key=` serving both `SET` and the implicit `GET`.

**Design**: new `POOL ASSIGN` tab (4th tab, `page` format allows up to
8). Top frame ("SELECT PAD") holds an 8×2 `list` widget — one widget for
all 16 pads, tap to select which pad's pool you're editing, plus a
`pool_editing_label` readout and a `RESET` button (restores that pad's
`DEFAULT_PAD_LAYOUT` entry). Bottom frame ("CATEGORIES") holds the 23
category toggles in a 6×4 grid (one slot unused). Total: 1 list + 1
readout + 1 button + 23 toggles + 2 frames ≈ 28 widgets, well under the
64 cap — the "user might build a real page here" version of the earlier
rough math, not just an estimate.

**Two real bugs the render caught, not the numbers**:
- First draft declared the `list` widget's box at `h=124` for a
  `th=130 rows=2 gap=10` grid (needs 270px) — `render_conf_preview`
  itself printed `WARNING: list grid_h=270 exceeds declared h=124`, not
  a silent visual bug this time. Fixed by deriving `th` from the
  available height instead of guessing a round number first.
- The `pool_editing_label` readout and `RESET` button were first placed
  at `y+32` inside the "SELECT PAD" frame — squarely on top of
  `frame_box()`'s own title text (drawn at `y+14`) and divider rule
  (`y+38`, confirmed by reading that function directly, both in the
  preview tool and the real `force_shadow.c`). The render showed a
  single stray "S" where "SELECT PAD" should have been. Fixed by moving
  that row below the divider.

**Backend** (`daemon.mjs`): `pool_pads`/`pool_pad_sel`/`pool_editing_label`
(GET), `pool_pad_sel`/`pool_cat_<category>`/`pool_reset` (SET) — the one
place this daemon tracks a "currently selected" index (`state.poolSel`),
since 16×23 individual per-pad-per-category toggles is nowhere near the
widget budget, so the page edits one pad's pool at a time. No new core
logic: reads/writes go straight through `core/kit_model.mjs`'s existing
`padPool()` and `core/storage.mjs`'s existing `savePadLayoutEntry()` —
the same function the web UI's `SET_POOL` action already uses. Category
list (`ROLE_ORDER`, 23 entries) is hardcoded into
`tools/gen_shadow_page.py` rather than read live from
`core/sample_index.mjs` (the generator script has no Node runtime to
import it with) — flagged as a hand-sync risk, same class as the
engine/web/shadow triple `shadow-gui.md` already warns about generally:
a mismatch wouldn't error, it would just leave one category untoggleable.

**Verified**: full protocol tested end-to-end against a real `daemon.mjs`
(Docker fixture harness) — default pools match `DEFAULT_PAD_LAYOUT`
exactly (pad 1 = kick only, pad 2 = rim+snare), adding/removing a
category persists and reflects immediately on the next `GET`, switching
`pool_pad_sel` correctly isolates state per pad (toggling pad 1's pool
doesn't affect pad 2's), `RESET` restores the exact default, and edge
cases (`pool_pad_sel 99`, a nonexistent category key) degrade gracefully
rather than erroring. All four tabs rendered together with no warnings.
Full `tests/run.js` suite (104 cases, unaffected) still passes.

**PLAY button colour**: also asked to make `PLAY` stand out — `button`
widgets support a per-button `color=` override (confirmed in both the
preview tool and the real `force_shadow.c` parser), used here with the
same hex as `theme_accent` so it's visually consistent with the rest of
the orange accent, not a clashing third colour.

**Not tested**: the same real-hardware gap as everything else in this
file — a live touchscreen tap on `POOL ASSIGN`'s toggles, and whether
the 8×2 pad-select list reads comfortably at native resolution with 16
real (not fixture) items.
