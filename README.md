# SFV Reference Implementation — v0.7.0

Independent short-form-video browser player based on a separately installed,
pinned dash.js checkout, with a discrete-event Node.js simulator. Both runtimes
execute the **same JavaScript B1/B2 adaptation rules**. The optional
`causal-simple` timing mode uses configurable, deterministic processing and
observation steps; it is not fitted to one browser's delay distribution.

## Install and run

Requirements: Git, Node.js 20+ and npm. The simulator and automated tests do
not need a browser or a locally built dash.js bundle.

```sh
npm ci
npm run verify
npm run simulate:causal
```

To run the actual browser player, follow [Getting started](docs/GETTING_STARTED.md).
Generated outputs are written to ignored `out/`. The code uses relative or
configurable paths; no dataset outside the included small example fixtures is
required for the default simulations.

## Documentation

- [Getting started](docs/GETTING_STARTED.md): install the pinned dash.js patch, run the player and simulator.
- [Architecture](docs/reference/sfv_reference_architecture_summary.md): implementation boundaries and shared execution rules.
- [Technical plan](docs/reference/sfv_technical_implementation_plan.md): implemented functionality and current work items.
- [Validation](docs/VALIDATION.md): repeatable scenarios, distinct replay and independent-prediction claims, and cache tests.

The included media fixtures and dash.js-derived patch need a separate
provenance/licensing review before redistribution. Raw browser recordings,
generated results and credentials must not be committed. See
[Contributing](CONTRIBUTING.md) and [Security](SECURITY.md) for repository rules.
