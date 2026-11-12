# Co-simulation with an external network

An external harness can run SFV sessions against its own network simulator, for example the [VQEG CAP–CSP collaboration pilot](https://github.com/VQEG/cap-csp-collaboration-test-pilot) with the FikoRE 5G emulator. The harness owns simulation time and byte delivery. SFV owns playback, ABR decisions, swipes and session records.

The harness starts `scripts/cosim-network-step-worker.mjs` as a child process and exchanges one JSON object per line on stdin and stdout. Every request gets exactly one reply. A failure is answered with `{"type": "error", "message": "..."}` and leaves the process running.

## Components

The worker wraps two classes in `src/cosim/`, both exported from `src/index.js`:

- `SFVNetworkStepHarness` runs one `SFVSimulationController` per UE on a shared clock, applies each network step to all UEs, collects their network actions, and drains CAP reports.
- `SFVExternalTransport` is the transport of each controller. It turns requests and aborts into `submit_request` and `cancel_request` actions and keeps the media metadata of each request on the player side. The external network only sees an opaque request ID and a byte count.

## Messages

`initialize` creates the harness and is answered with `{"type": "initialized"}`:

```json
{
  "type": "initialize",
  "config": {
    "dataset": { "videos": [] },
    "sessions": [
      {
        "ue_id": 0,
        "player_behavior": "simple",
        "config": { "sessionStartTimeS": 0, "sessionEndTimeS": 30 },
        "rule_config": {}
      }
    ],
    "timingDefaults": {},
    "duration_s": 30,
    "network_backend": "transport_fikore",
    "run_id": "example",
    "signaling_level": "L0",
    "condition": "C1",
    "swipe_profile": "scripted"
  }
}
```

`player_behavior` selects `SFVCurrentVideoRule` (`simple`, B1) or `SFVMultiVideoPrefetchRule` (`preload`, B2). `duration_s` and `network_backend` are required.

`network_step` advances all sessions to `step.time_s` and applies the step's download events. The first step must be at `t = 0`, times must increase, and the step with `is_final: true` must be at `duration_s`:

```json
{
  "type": "network_step",
  "step": {
    "time_s": 0.5,
    "is_final": false,
    "events": [
      {
        "event_type": "DownloadProgress",
        "ue_id": 0,
        "request_id": "ue0-r1",
        "time_s": 0.5,
        "bytes_delivered": 12000
      }
    ],
    "collaboration": { "csp_by_ue": { "0": { "plan_downlink_mbps": 10 } } }
  }
}
```

Event types are `DownloadProgress` and `DownloadCancelled` (with cumulative `bytes_delivered`) and `DownloadCompleted`. The optional `collaboration.csp_by_ue` object carries the CSP fields each UE may see at the current signaling level. The harness passes them to `applyCspUpdate` only when a UE's fields change.

A non-final step is answered with the network actions to execute before the next step:

```json
{
  "type": "player_actions",
  "actions": [
    { "op": "submit_request", "ue_id": 0, "request_id": "ue0-r2", "bytes_total": 52129 },
    { "op": "cancel_request", "ue_id": 0, "request_id": "ue0-r1" }
  ]
}
```

The final step is answered with `{"type": "player_step_result", "actions": [], "result": {...}}`, where `result.sessions` holds the session record of each UE. Requests still open at that point are recorded as cancelled.

`cap_reports` is answered with `{"type": "cap_reports", "reports": {"0": {...}}}`. A UE appears only when `drainCapReports` has a report due: on a stall edge, a video switch or a buffer change of at least 1.0 s, at most once per second of session time. After the final step the rate limit does not apply, so the terminal state is always reported.
