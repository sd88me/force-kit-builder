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

## Requirements

**An existing nodeServer install on the Force.** This is not a standalone
addon — it's a plugin patched into
[nodeServer](https://github.com/) (a MockbaMod addon most `force-*` setups
already run). See DESIGN.md's "Architecture" section for why.

## Install

```sh
./install.sh /media/662522/AddOns/nodeServer/app
```

(pass the actual path to your nodeServer's `app/` directory; the script will
try to auto-detect it via `/dev/shm/.mmPath` if you omit the argument, but
that's a convenience, not a guarantee). If nodeServer's `ENDPOINTS.js`
doesn't already have a `/kit-builder` route, the script prints the one-line
entry to add by hand (also in `plugin/ENDPOINTS.patch.md`).

Restart nodeServer (kill its `node` process — its own watchdog relaunches
it), then open:

```
http://<force-ip>:8080/kit-builder
```

## Development

```sh
npm test          # node tests/run.js
```

No build step for the web UI — `plugin/api/endpoints/kitbuilder/{client.js,
style.css,template.html}` are served as-is by the endpoint, same as the rest
of nodeServer's own tools.

## License

MIT — see [LICENSE](./LICENSE).

## Credits

The kit-building engine — sample classification, random assignment, loudness
matching, and the MPC `.xpm` export — originated in
[schwung-kit-builder](https://github.com/sd88me/schwung-kit-builder) and was
ported here to run as a browser UI on the Force.
