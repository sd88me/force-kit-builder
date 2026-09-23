# Force Kit Builder

A web-based 16-pad drum-kit builder for the Akai Force running MockbaMod.
Scans your sample library, auto-categorizes and randomly assigns samples
onto a 16-pad grid, lets you lock/favourite/reject/reassign individual pads
from a browser, and exports straight to an Akai MPC `.xpm` drum program on
the Force's own disk — no hardware buttons, no separate export/transfer step.

See [DESIGN.md](./DESIGN.md) for the full architecture, data model, and API
reference.

## Features

- **16-pad grid UI**, laid out like the hardware — each pad shows its sample
  name, a colour-coded category badge, and a small waveform preview, right
  on the tile.
- **Per-pad category/pool picker** — click a pad's category badge to change
  which sample pool it draws from, right there on the grid.
- **Auto-categorization** of your sample library by folder name and filename
  keyword, across 23 categories (kick, snare, rim, clap, hat/closed/open,
  tom, conga, percussion, crash/ride/cymbal, fx, **glitch** (grain/granular/
  glitchy), vox, bass, synth, stab, chord, lead, pad, other).
- **Random Assign** across the whole kit (seeded, duplicate-avoiding, with
  automatic relaxation if a category pool runs too small) plus a per-pad
  **Reroll** for just one slot.
- **Lock** a pad to protect it from Assign/Clear/Reroll; **Favourite**/
  **Reject** a sample library-wide (favourites are weighted up in future
  picks, rejects are excluded permanently).
- **Gain trim per pad** and a one-click **Match Levels** that
  attenuates loud pads toward the quietest, measured directly from each
  sample's own audio data — no plugin, no DSP, entirely server-side.
- **Waveform preview**, per pad and in the detail panel, computed server-side
  so it works for real-world sample-pack content (24-bit, 32-bit float,
  extended headers) that a browser's own audio decoder often rejects.
- **Click-to-audition** any pad's sample straight in the browser.
- **Multiple sample source folders**, picked via a reused file-browser modal
  (the same one nodeServer's own File Manager uses), with a chunked
  background rescan and configurable filters (skip loops, max file size).
- **Load an existing `.xpm` kit** to keep editing it — reads a kit's pad
  samples back in from disk, re-classifies them, and picks up right where
  that kit left off.
- **Export to Akai MPC `.xpm`** — a self-contained folder (the `.xpm` plus
  every sample it uses, plus a `MANIFEST.txt`) written wherever you point
  the destination picker. Confirmed working on real hardware at
  `Expansions/Kits & Patterns/`, where the Force's own factory kits live.
- **Fully headless** — everything above happens in a browser on your phone,
  tablet, or computer; nothing runs on the Force's own touchscreen.

## How to use

1. **Install** (see below), then open `http://<force-ip>:8080/kit-builder`
   in any browser on the same network.
2. **Add a sample folder** — click **+ Add folder…** under *Sample Sources*
   and browse to a folder of `.wav`/`.aif`/`.aiff` files (add as many
   folders as you like). Click **Rescan** to index them.
3. **Assign** — click **Assign** in the toolbar to randomly fill every
   unlocked pad. Don't like one pad? Click it, then hit **Reroll** in the
   side panel to redraw just that slot.
4. **Fine-tune individual pads** — click a pad to select it:
   - The **category dropdown** on the tile changes which pool that pad slot
     draws from (e.g. switch pad 7 from `hat` to `glitch`).
   - **L** locks the pad (protects it from Assign/Clear/Reroll).
   - **★** favourites the current sample (weighted up in future picks,
     library-wide); **✕** rejects it (excluded from now on).
   - The side panel's **gain slider** trims that pad's level, and shows a
     larger waveform.
5. **Match Levels** in the toolbar auto-balances every assigned pad's
   volume.
6. **Load an existing kit** — click **Load XPM…** and pick any `.xpm` file
   sitting next to its samples (e.g. one of the Force's own factory kits) to
   load it back in and keep editing.
7. **Save** keeps a working copy of the kit itself (for coming back to it
   later); **Export** under *Export (MPC .xpm)* writes the actual `.xpm` +
   samples to a destination folder you pick — that's what the Force's own
   Program browser loads.

## Touchscreen GUI (shadow mode)

A second, standalone `ForceKitBuilder` addon renders a full editor page for
the Force's own touchscreen, via
[`force-shadow`](https://github.com/sd88me/force-shadow): reach it through
force-shadow's ADD-ONS launcher (`SHIFT+SCENE-1`, then select Kit Builder)
rather than a direct `SHIFT+SCENE-N` combo — all seven of those are already
claimed by other addons on this device. It shares the same working kit and
preferences as the web UI above (both read/write the same files on disk), so
generating a kit on the touchscreen and opening the web UI shows the same
kit, and vice versa.

| Tab | Contents |
|-----|----------|
| PADS | A 16-pad performance grid — each pad has its own PLAY, a tap-to-select category "pill" (also jumps to DETAIL for that pad), and REROLL. Pad frames tint live to match each pad's assigned category. |
| DETAIL | Full per-pad editing for whichever pad you've selected — the 23-category pool matrix, a GAIN knob, lock/clear/reroll/play, pad navigation via a stepper, plus the kit-wide GENERATE ALL, CLEAR ALL, NORMALISE, EXPORT KIT and RESCAN LIBRARY actions. |

Both tabs show a status line in the top bar confirming the last action
(generated, cleared, normalised, library rescanned, or the name of the kit
just exported).

> **The web UI has more detail and all the settings.** Open
> `http://<force-ip>:8080/kit-builder` for everything the touchscreen
> leaves out: choosing **sample source folders** and **scan filters**, the
> **export destination folder**, waveform preview, per-pad sample
> browsing, favourites/rejects and XPM import. The touchscreen's EXPORT
> KIT and RESCAN LIBRARY buttons use the folders set there, so do a first
> export and pick your sample folders in the web UI before relying on them.

The two surfaces are complementary, not duplicates - a touchscreen has
nowhere sensible to put a file-path field or a free-form editor.

## Audible pad preview

A separate on-demand process, `preview_host`, lets you hear whatever sample
is currently on a pad — tap that pad's PLAY control on the shadow page (or
DETAIL's PLAY) — before you ever export. It plays the sample through the
Force's own audio engine via a shared-memory injection tap, the same
mechanism Maze Voice, DX7 and JV-880 already use to get audio into the
Force's mix.

Requires the separate [`ForceAudioJack`](https://github.com/sd88me/force-audio-jack)
addon to be enabled, and — like every other voice/preview producer in this
family — a hard rule: **never restart `acvs` while `preview_host` is
attached.** Unlike those other addons, it's never started via a manual
POWER toggle on the nodeServer Modules page (`engine_autostart=1` in
`addon/shadow_page.conf`): force-shadow starts it the moment the Kit
Builder page becomes active and stops it the moment you leave — the same
`/moduler` start/stop path the manual toggle uses elsewhere, just called
automatically for a utility that only does anything while its own page is
open. It's still never auto-launched at boot. The injected audio is only
actually audible if the current Force project has an Audio-In track
routed to it (the same one-time per-project setup those other addons
already require).

> **Known limitation:** `preview_host` is configured for ForceAudioJack
> voice slot 3 (`addon/NSMODULE.json`), based on the other voice addons'
> own slot numbering (0=Maze Voice, 1=JV-880, 2=DX7) — this has not been
> confirmed live against a real device's `/dev/shm`. Check before relying
> on it; see DESIGN.md's "Known limitations" section.

## Requirements

**An existing nodeServer install on the Force**, for the web-UI plugin —
this is not itself a standalone addon, it's a plugin patched into
nodeServer (a bundled MockbaMod addon most `force-*` setups already run).
See DESIGN.md's "Architecture" section for why.

For the touchscreen GUI and audible preview, you additionally need
`force-shadow` installed (for the shadow page) and, only for preview audio,
the separate `ForceAudioJack` addon.

## Installation

Three parts, installed in this order. `scripts/deploy.sh` automates all of
step 1 and 2 over SSH — see its own header for exactly what it does; step 3
is always a manual, on-device action per the hard rule above.

1. **nodeServer plugin** (the web UI) — patch it into your existing
   nodeServer install:

   ```sh
   ./install.sh /media/662522/AddOns/nodeServer/app
   ```

   (pass the actual path to your nodeServer's `app/` directory; the script
   will try to auto-detect it via `/dev/shm/.mmPath` if you omit the
   argument, but that's a convenience, not a guarantee). If nodeServer's
   `ENDPOINTS.js` doesn't already have a `/kit-builder` route, the script
   prints the one-line entry to add by hand (also in
   `plugin/ENDPOINTS.patch.md`).

   Restart nodeServer (kill its `node` process — its own watchdog relaunches
   it), then open:

   ```
   http://<force-ip>:8080/kit-builder
   ```

2. **`ForceKitBuilder` addon** (the touchscreen GUI's always-on backend) —
   copy `addon/` to `AddOns/ForceKitBuilder` on the device and run:

   ```sh
   ./manage.sh ENABLE
   ```

   This just copies its boot-loop launcher and starts `daemon.mjs` — no
   `LD_PRELOAD`, no `acvs` restart, safe to run unattended.

3. **`preview_host`** (audible preview, optional) — once `ForceAudioJack`
   is enabled, `preview_host` starts and stops itself automatically as you
   enter/leave the Kit Builder shadow page (`engine_autostart=1`) — no
   manual toggle needed. Never auto-launched at boot, and never started as
   part of steps 1 or 2.

## Building from source

```sh
npm test                     # node tests/run.js — core/exporter unit tests
./scripts/build_preview.sh   # cross-compiles addon/host/preview_host for armhf
                              # (via Docker/QEMU, or natively if CROSS_PREFIX is set)
```

No build step for the web UI — `plugin/api/endpoints/kitbuilder/{client.js,
style.css,template.html}` are served as-is by the endpoint, same as the rest
of nodeServer's own tools. `addon/shadow_page.conf` is generated, not
hand-edited — `python3 tools/gen_shadow_page.py addon/shadow_page.conf`.

## Project layout

```
core/           pure ES modules — classification, assignment, loudness, storage
exporters/      MPC .xpm read/write
plugin/         nodeServer endpoint + web UI (client.js, style.css, template.html)
addon/          standalone ForceKitBuilder addon — daemon.mjs, preview_host,
                shadow_page.conf, manage.sh, NSMODULE.json
tools/          shadow_page.conf generator
scripts/        preview_host build (Dockerfile, build_preview.sh) + deploy.sh
tests/          unit tests (node tests/run.js)
install.sh      nodeServer plugin installer (runs on the device)
```

## Related projects & credits

The kit-building engine — sample classification, random assignment, loudness
matching, and the MPC `.xpm` export — originated in
[schwung-kit-builder](https://github.com/sd88me/schwung-kit-builder) and was
ported here to run as a browser UI on the Force.

Built for [MockbaMod](https://github.com/MockbaTheBorg/MockbaMod), and
depends on [`force-shadow`](https://github.com/sd88me/force-shadow) for the
touchscreen GUI and, only for audible preview,
[`force-audio-jack`](https://github.com/sd88me/force-audio-jack).

## License

MIT — see [LICENSE](./LICENSE).
