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
npm run serve:browser
```

Open http://127.0.0.1:8080/; paste `web/public/experiment-example.json` into
**Enter Configuration**, start an experiment and export **Full Session JSON**.
Save exported browser runs outside the Git working tree (or under ignored
`out/`). `npm run verify` cannot replace real browser/MSE tests. Only use
`--verify-installed` if the pinned checkout has already been patched; do not
apply the patch twice. For a non-sibling checkout, set `SFV_DASHJS_ROOT`.

On Windows run the same `npm`, `git` and `node` commands in PowerShell; on
Linux/macOS use your normal shell. Check browser autoplay permission if playback
is blocked. A cross-OS real-browser CI matrix has not been established.

## Replay commands

To prepare configurations for new full browser exports:

```sh
npm run validate:supplementary:prepare
npm run serve:browser
```

See [Validation](VALIDATION.md) for the exact independent/trace-conditioned,
repeatability and cache comparison commands and scientific limitations.
