# Getting started — Windows, Linux and macOS

## Requirements

Install Git, Node.js 20+ and npm. For real browser playback also install a
supported browser and obtain the exact upstream dash.js source separately.
The simulator and its tests do **not** require dash.js to be built.

```sh
# From SFV-Reference-Implementation/
npm ci
npm run verify
npm run simulate:causal
npm run validate:scenarios
npm run validate:scenarios:stall
```

Example timing parameters: `examples/causal-simple-timing.json`;
full experiment example: `examples/causal-simple-experiment.json`.
All results go to ignored `out/`.

## Install the only supported dash.js patch (browser)

From the **parent** directory of `SFV-Reference-Implementation/`:

```sh
git clone https://github.com/Dash-Industry-Forum/dash.js.git
cd dash.js
git checkout --detach b1bde9f45f35e4565eaeb1ea4dfd6a5f8fd44bdb
cd ../SFV-Reference-Implementation
node scripts/prepare-dashjs.mjs ../dash.js --check
node scripts/prepare-dashjs.mjs ../dash.js --apply
node scripts/prepare-dashjs.mjs ../dash.js --verify-installed
cd ../dash.js
npm ci
npm run ci:verify
npm run webpack-build-modern
cd ../SFV-Reference-Implementation
node scripts/prepare-dashjs.mjs ../dash.js --install-bundle
npm run serve:browser
```

`--install-bundle` verifies the patched checkout again, checks that the build is
newer than the patched sources and exposes the SFV methods, then copies
`dash.all.min.js` into `web/vendor/` together with the dash.js licenses and
`dashjs-build.json` (dash.js commit, patch and bundle SHA-256). The web server
serves only this in-repository bundle; the dash.js checkout is not needed at
runtime. Rerun `--install-bundle` after every rebuild. To serve a different
bundle file, set `SFV_DASHJS_BUNDLE`.

Open http://127.0.0.1:8080/; paste `web/public/experiment-example.json` into
**Enter Configuration**, start an experiment and export **Full Session JSON**.
Save exported browser runs outside the Git working tree (or under ignored
`out/`). `npm run verify` cannot replace real browser/MSE tests. Only use
`--verify-installed` if the pinned checkout has already been patched; do not
apply the patch twice. For a non-sibling checkout, pass its path instead of
`../dash.js`.

On Windows run the same `npm`, `git` and `node` commands in PowerShell; on
Linux/macOS use your normal shell. Check browser autoplay permission if playback
is blocked. A cross-OS real-browser CI matrix has not been established.

## Environment variables

Only the browser web server (`npm run serve:browser`, `web/server.mjs`) reads
environment variables, once at startup; changing them requires a restart. The
simulator, validation scripts and `prepare-dashjs.mjs` read none.

| Variable            | Default                      | Purpose                                                                                                                                                                        |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SFV_HOST`          | `127.0.0.1`                  | IP address to listen on. Use `0.0.0.0` (or `::`) for all interfaces; the control endpoints have no authentication, so only do this on trusted networks.                        |
| `PORT`              | `8080`                       | TCP port. `0` picks a free port, printed at startup.                                                                                                                           |
| `SFV_BASE_PATH`     | _(empty: site root)_         | Common subpath for all routes, e.g. `/lab/sfv`; `/lab/sfv` redirects to `/lab/sfv/`. Segments may contain letters, digits, `.`, `_`, `~` and `-`; anything else fails startup. |
| `SFV_DASHJS_BUNDLE` | `web/vendor/dash.all.min.js` | Path of the patched dash.js bundle served at `vendor/dash.all.min.js`. Startup fails if the file does not exist.                                                               |

```sh
SFV_HOST=0.0.0.0 PORT=9000 SFV_BASE_PATH=/sfv npm run serve:browser
# SFV browser demo: http://0.0.0.0:9000/sfv/
```

In PowerShell set them first, e.g. `$env:SFV_BASE_PATH = '/sfv'`.

### Docker

The image sets `SFV_HOST=0.0.0.0`, `PORT=8080` and `NODE_ENV=production`;
override any variable with `docker run -e`, e.g.
`docker run --rm -p 127.0.0.1:8080:8080 -e SFV_BASE_PATH=/sfv sfv-browser`.
Build arguments (`docker build --build-arg`): `NODE_VERSION` (default `22`) and
`DASHJS_COMMIT` (default: the pinned `b1bde9f…`; the SFV patch only applies to
that commit).

## Replay commands

To prepare configurations for new full browser exports:

```sh
npm run validate:supplementary:prepare
npm run serve:browser
```

See [Validation](VALIDATION.md) for the exact independent/trace-conditioned,
repeatability and cache comparison commands and scientific limitations.
