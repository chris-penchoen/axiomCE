---
title: AxiomCE Ownership Model
type: framework
classification: public
status: public-preview
updated: 2026-07-15
---

# Ownership Model

> **Authority.** The authoritative ownership model is the Axiom governance plane —
> specifically the Authority registry in `06_ARCHITECTURE.md` (§8.1), which defines
> who or what owns each concept and who may ratify changes. The table below is an
> implementation-facing projection of that registry, not a competing source of truth.

AxiomCE is organized around responsibility, not merely folders.

| Concept | Authoritative owner |
|---|---|
| Facts | Claim records |
| Provenance | Source records |
| Identity | Entity records |
| Conflicts | Reconciliation layer |
| Current human-readable context | Generated or canonical views |
| Collaboration policy | Cognitive-model policy |
| Good versus poor collaboration | Calibration corpus |
| Model-specific quirks | Model adapters |
| Evaluation observations | Evaluation records |
| Canonical policy approval | Human ratification |
| Task execution | Current AI model |

## Core rule

Every atomic fact or policy rule should have exactly one authoritative owner.

Other documents may reference it, summarize it, or generate views from it, but should not silently become competing sources of truth.