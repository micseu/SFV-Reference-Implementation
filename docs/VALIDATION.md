# Validation — scope and commands

Run `npm ci && npm run verify` first. Browser experiments require the separately
installed and patched dash.js; automated Node tests do not run a real browser.
All full browser exports and generated reports belong in ignored `out/` or an
access-controlled dataset store, **not Git**.

## Canonical B1/B2 simulation scenarios

```sh
npm run validate:scenarios
npm run validate:scenarios:stall
```

Scenario JSON files in `scenarios/validation/` use the **experiment-v1 data
schema** (the suffix `v1` denotes a data-contract/scenario revision, not a software release). These commands generate browser configurations and simulator
results in `out/validation-*`; run each browser configuration in the real UI
separately to obtain full browser session exports.

## Three distinct comparisons

1. **Trace-conditioned replay**: uses observed browser platform timings as
   inputs, but recalculates rule/throughput/requests. Earlier full B1/B2 exports
   passed 15/15 and 18/18 configured checks. This is *not* independent prediction.
2. **Independent playback prediction**: no recorded browser playback timings,
   throughput, quality choices or downloaded resource trace injected. Earlier
   independent results remain `review-required` (B1 12/15, B2 17/18).
3. **Independent causal-simple prediction**: same independent inputs with the
   illustrative deterministic timing profile. It was not tuned to pass earlier
   browser recordings; earlier tests also remained `review-required`.

```sh
npm run validate:browser-replay:acceptance -- B1-run1.json B2-run1.json out/trace-conditioned
npm run validate:supplementary -- independent B1-run1.json B2-run1.json out/independent
npm run validate:supplementary -- independent-causal B1-run1.json B2-run1.json examples/causal-simple-timing.json out/independent-causal
```

Commands require **complete full browser JSON exports**, not summary reports.
B1 and B2 runs must use compatible versions/configuration and explicitly
recorded network/user profiles. Browser throughput and first-frame semantics
may differ from the virtual-clock model; report misses rather than weakening
thresholds to produce a pass.

## Repeatability and session-cache isolation

Use `npm run validate:supplementary:prepare`, then repeat each generated B1 and
B2 browser configuration **three times**. Keep the same page/tab open between
repeated runs for the cache comparison, and export all six full session JSONs.

```sh
npm run validate:supplementary -- repeatability B1-run1.json B1-run2.json B1-run3.json out/repeat-B1
npm run validate:supplementary -- repeatability B2-run1.json B2-run2.json B2-run3.json out/repeat-B2
npm run validate:supplementary -- cache B1-run1.json B1-run2.json out/cache-B1
npm run validate:supplementary -- cache B2-run1.json B2-run2.json out/cache-B2
```

In earlier measurements, B1 repeatability and both B1/B2 cache-isolation tests
passed. The earlier B2 repeatability report had incomplete evidence of
prefetched-video quality. The updated evaluator checks **actual appended
segments**, but requires the three original complete browser runs for a fresh
result. Successful cache checks establish new server-confirmed SFV HTTP
transfers, **not** clearing every browser cache globally. Repeatability samples
cover the tested browser/configuration only; no cross-platform certification.

For simulator-only rule diagnostics: `npm run validate:abr:diagnostics`.
All acceptance criteria and resolved experiment parameters are exported by the
corresponding validator under `out/`.
