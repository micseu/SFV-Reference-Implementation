# SFV technical implementation plan — v0.7.0

## Implemented contracts

- Validate versioned `experiment-v1` JSON before starting the browser session;
  use deterministic/seeded user and network inputs, configurable per-UE FIFO
  admission and identical JavaScript B1/B2 rules in browser and simulator.
- Execute ordered actions and observable request lifecycle, cancellation and
  completed/aborted byte accounting without a hidden global request-count cap.
- Keep browser HTTP cache, logical `SFVSegmentStore` and MSE buffer distinct;
  reset session resources and require fresh HTTP requests across sessions.
- Model playback, stalls, multi-UE shared capacity, configurable `causal-simple`
  processing/observation timing and a virtual clock. Keep conditional replay
  separate from autonomous simulation; export resolved inputs and outputs.
- Maintain a single supported patch for the pinned dash.js revision.

## Reproduce

```sh
npm ci
npm run verify
npm run simulate:causal
npm run validate:scenarios
npm run validate:scenarios:stall
```

See [Getting started](../GETTING_STARTED.md) for the dash.js checkout,
one-time patch/build and browser UI. Run real browser scenarios and export
*full session JSON* before invoking replay and supplementary comparisons as
explained in [Validation](../VALIDATION.md). Output is under ignored `out/`;
record input JSON, seeds, timing profile, browser/OS and code revision alongside
stored results. The small included fixtures support baseline runs; never commit
raw browser exports or large/generated datasets.

## Acceptance and remaining work

Functional tests, trace-conditioned browser replay and independent prediction
make distinct claims. Earlier conditional replay passed B1 15/15 and B2 18/18
checks on recorded browser runs. Independent B1/B2 prediction remains
`review-required` (12/15 and 17/18), including the illustrative deterministic
timing profile. The same-page B1/B2 HTTP-cache-isolation tests and B1 browser
repeatability passed for the tested scenarios. Repeat corrected B2 quality
validation using three complete browser recordings; do not infer success from
an earlier summary alone.

Before broader distribution, audit fixture-media provenance, dash.js-derived
patch rights and source licenses. Extend actual-browser and cross-platform
coverage where required, and investigate request/observation timing differences
without tuning the generic simulator to one recorded browser run. Keep
`main` working and record each future logical change in a focused commit.
