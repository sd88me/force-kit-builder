# ENDPOINTS.js patch

`install.sh` copies `plugin/api/endpoints/kitbuilder/` into an existing
nodeServer install and prints this same snippet when it can't find an
existing `/kit-builder` entry to confirm is already there. Add this object
to nodeServer's own `app/api/ENDPOINTS.js`, inside its `module.exports`
array, alongside its other entries:

```js
    {
        NAME: "Kit Builder",
        PATH: "./api/endpoints/kitbuilder/index.js",
        PARAM: "/kit-builder",
        URL: "/kit-builder",
        HIDDEN: false,
        HOME: true,
        TARGET: "_self"
    },
```

Notes:

- `PARAM`/`URL` are the plain relative route (`/kit-builder`), never an
  absolute `http://host:port` URL — that's what the `force-acid`/`force-dx7`/
  `force-jv880` redirect-stub pattern has to work around (`home.js` renders
  every link through the legacy global `escape()`, which percent-encodes a
  `:` and breaks an absolute URL). Since this plugin is a real in-process
  nodeServer route, not a redirect to a separate standalone server, that
  problem doesn't apply here — `PARAM`/`URL` just being `/kit-builder` is
  correct as-is, not a workaround.
- `TARGET: "_self"` navigates in the same tab/window, matching most of
  nodeServer's other full-page tools (`file-browser`, `moduler`, etc.) rather
  than the `TARGET: "FORCEACID"`-style stable-tab convention the standalone
  `force-*` redirect stubs use (that convention exists so repeat clicks on a
  *cross-origin* redirect reuse one browser tab/window instead of spawning a
  new one each time — irrelevant for a same-origin in-process route).
- Restart nodeServer after adding this (kill its `node` process — its own
  watchdog relaunches it) for the new route to be picked up.
