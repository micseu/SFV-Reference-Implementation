# SFV reference architecture — v0.7.0

## Scope

An independently installed, pinned-dash.js browser reference player and an
event-driven Node.js single-/multi-UE simulator use **the same canonical
JavaScript B1/B2 rules**. Both pass normalized observation batches into
`SFVAbrController` and handle ordered `FETCH_MANIFEST`, `FETCH_INIT`,
`FETCH_MEDIA`, `APPEND`, `ABORT` and `WAIT` actions. Neither runtime substitutes
a different implementation of the adaptation algorithm.

## Resource and playback model

The browser uses one active dash.js playback slot and lightweight future-video
catalog entries. Request admission and FIFO queues are per UE, with a local
concurrency limit; multi-UE simulations share network capacity without a global
request-count cap. B1 downloads only resources for the active video. B2 can
prefetch future-video segments within aggregate MPS and per-video PSPV budgets.

`SFVSegmentStore` is distinct from both HTTP cache and the MSE playback buffer.
An optional storage limit is applied *after* successful download; lifecycle
cleanup removes entries no longer needed. A new browser session resets the
logical store and active playback slot. SFV HTTP requests use `no-store`, and
the UI attempts selective CacheStorage cleanup rather than claiming a global
browser-cache purge.

## dash.js integration and timing

Only `patches/dashjs-b1bde9f-CONSOLIDATED.patch` is supported. Apply it once
to the separately obtained upstream dash.js commit
`b1bde9f45f35e4565eaeb1ea4dfd6a5f8fd44bdb`, following
[Getting started](../GETTING_STARTED.md). An unpatched dash.js build does
not expose the required SFV request-scheduling and cached-append interfaces.
The dash.js bundle is not included in this repository.

The simulator owns its virtual clock. Optional `causal-simple` timing models
slot readiness, serialized append, playback readiness and periodic playback
observations using separately configurable deterministic assumptions. The
legacy virtual-clock behavior remains available to reproduce existing scenario
inputs. `browser-platform-trace` is an *explicitly conditional* replay mode:
recorded platform timing can be supplied, but throughput and ABR decisions are
recomputed; it is not independent timing prediction. `experiment-v1` and other
`v1` data schema suffixes are independent of the software release number.

## Evidence boundary

For previously recorded, scenario-specific browser runs, trace-conditioned
replay passed B1 15/15 and B2 18/18 checks. Independent prediction for those
runs remained `review-required` (B1 12/15; B2 17/18). Tested B1 repeatability
and two-session B1/B2 server-confirmed fresh HTTP transfers passed. The B2
repeatability evaluator now checks actually appended segment quality, but the
corrected evaluation still requires the three complete original browser exports.
These results are not a claim of exact first-frame, native-app or cross-OS parity.
See [Validation](../VALIDATION.md) for commands and interpretation.
