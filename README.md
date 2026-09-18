# Force Kit Builder

A web-based 16-pad drum-kit builder for the Akai Force running MockbaMod.
Scans your sample library, auto-categorizes and randomly assigns samples
onto a 16-pad grid, lets you lock/favourite/reject/reassign individual pads
from a browser, and exports straight to an Akai MPC `.xpm` drum program on
the Force's own disk — no Ableton Move, no hardware buttons, no separate
export/transfer step.

It's a port of [schwung-kit-builder](../schwung-kit-builder) (the same
kit-building engine originally built for Ableton Move's Schwung), with every
Ableton/Move preset format dropped and the on-device hardware UI replaced
entirely by a browser UI. See [DESIGN.md](./DESIGN.md) for the full
rationale, data model, API reference, and what changed vs. the original.

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
