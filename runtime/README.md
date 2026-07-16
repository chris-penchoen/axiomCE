---
title: Runtime — operational state
type: index
classification: public
created: 2026-07-15
updated: 2026-07-15
---

# Runtime

Operational state for the Continuity-Engine **runner**, kept deliberately
separate from *continuity* (the human-owned knowledge in `claims/`, `entities/`,
etc.). Nothing here is part of the ontology; it is the engine's own bookkeeping.

The separation is a hard boundary: the runner's checkpoints, dedup ledger, and
ratification queue must never pollute the human knowledge model, and human
knowledge must never depend on runner internals.

## Contents

| Path | Purpose |
|------|---------|
| `ledger.jsonl` | Append-only idempotency ledger. One entry per observed candidate claim, keyed by a stable content hash (`obs_id`). Lets `sync` skip anything already seen, so re-runs are no-ops. Records lifecycle: `queued` -> `ratified` / `discarded`. |
| `ratification-queue.jsonl` | Captured claims **pending human ratification**. `sync` writes here; it never appends to canonical `claims/` logs directly. `ratify` promotes approved entries into canon. |
| `runs/<timestamp>.json` | Per-run manifest: what was observed, queued, skipped (duplicate), and blocked (privacy/structural). The audit trail. |

Restricted/sensitive counterparts live under `private/runtime/` (git-excluded)
so sensitive claim values never enter a tracked file.

## The loop

```
observe        inbox/observations/*.jsonl        (agent-normalized candidate envelopes)
   |
   v
dedup          runtime/ledger.jsonl              (skip already-seen obs_id)
   |
   v
validate       planCapture gates                 (schema + privacy + referential)
   |
   v
queue          runtime/ratification-queue.jsonl  (PENDING -- not canon)
   |
   v
ratify (human) claims/*.jsonl                     (promote approved -> append-only canon)
   |
   v
project        portable context package          (hand to a new model)
```

`sync` runs steps observe->queue (idempotent, safe for unattended/`--watch`
operation); `ratify` runs the human-gated promotion; `project` is egress.

See `../tools/runner.mjs` and `../inbox/capture-envelope-spec.md`.
