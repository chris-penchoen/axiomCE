---
title: Cognitive Model — Collaborator Operating Model
type: index
classification: public
created: 2026-07-15
updated: 2026-07-15
status: template
---

# cognitive-model/ — how an AI should collaborate with the owner

This directory is the **collaboration plane** (the canon's term; "cognitive-model
pillar" is the implementation alias). It holds the durable, versioned knowledge
of *how* an AI should reason with, communicate with, and deliver to the owner —
as distinct from *what* is known about the owner's world (the knowledge plane).

An implementation has **two pillars**:

1. **Knowledge pillar** — *what is known or believed about the owner and their
   world.* Lives in `sources/`, canonical domain records, `claims/`, `entities/`,
   `views/`. Validated by **evidence and provenance** (`SOURCE_POLICY.md`,
   `kernel/BOOT.md`).
2. **Cognitive-model pillar** (this directory) — *how an AI should collaborate
   with the owner.* Validated by **repeated successful collaboration** —
   corrections and calibration — not by external evidence.

These are **different governance layers** and must not be merged:

- [`AGENTS.md`](../AGENTS.md) governs **how agents work on this repository**
  (privacy, epistemics, doc rules). It is the constitution and it wins on
  conflict.
- **This pillar** governs **how agents work with the owner** (delivery,
  decisions, friction, priorities, interaction).

They **reference** each other by ID; they do not restate each other.

## Structure (populate per implementation)

The framework ships this plane **empty**. An implementation adds:

- `policy/` — normative interaction/delivery rules with stable `CM-*` IDs
  (referenced from `AGENTS.md` §5–§6). This is policy that doubles as an
  evaluation rubric.
- `calibration/cases/` — worked examples of good vs. poor collaboration that
  the owner has ratified; the empirical basis for the policy.
- `adapters/` — per-model quirks and how to compensate for them.
- `evaluation/` — records of model-vs-policy evaluations (external; not a runtime
  dependency).

The cognitive model does **not** use the claim schema and is **not** a runtime
dependency. Structural checks: `node tools/validate-cognitive.mjs`.
