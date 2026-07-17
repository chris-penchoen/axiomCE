---
title: Threat Model and Engine Hardening Register
type: framework
classification: public
status: draft
created: 2026-07-17
updated: 2026-07-17
source: adversarial pass over the Axiom Canon (2026-07-16/17)
confidence: user-stated
---

# Threat Model and Engine Hardening Register

This is the engine's home for **mechanism hardening** — the work of making the
runner enforce what the canon *requires*. It exists because the Axiom Canon
stays a set of standing concepts; it does not carry a threat-model section
(that would bloat it). Clarity-only wording fixes go to the canon; mechanism
hardening lands here and in `tools/`.

## Scope

- **In scope:** ways an *honest actor* can weaponize a legitimate mechanism —
  dilution, downplaying, mis-routing, forced false resolution, ratification
  fatigue. These are design gaps in the engine, not misuse.
- **Out of scope (ruled):** a *dishonest actor* forging provenance or sources.
  The runner records derivation history; it does not adjudicate whether a
  human-supplied source is truthful. Forged-provenance defense is a separate
  concern and is deliberately excluded here.

## The one property the runner cannot enforce

The runner guarantees **structure** and **privacy**. It **cannot** guarantee
**meaning**. Only the model saw the source conversation, so only the model can
preserve a hedge, a negation, or an atomic fact. The capture-envelope spec
(`inbox/capture-envelope-spec.md`, rules F1–F10) binds the model; the runner
cannot detect a dropped negation or an inflated confidence. Every item below
that touches meaning is therefore *mitigation*, not *enforcement*.

## Register

Status legend: **done** · **proposed** (implemented this pass, pending review) ·
**needs-ratification** (design decision that changes ratified canon behavior;
per Axiom 18 a model proposes, the human ratifies — not yet built).

| # | Axiom | Threat | Location | Fix | Status |
|---|-------|--------|----------|-----|--------|
| H1 | 11 | Live contradiction downplayed to a single claim to "rely on", hiding disagreement from the next model. | `runner.mjs` `assembleContext` (contradiction render) | Render as **UNRESOLVED**, show every side in proportion, label the pick a safety-default, not a ruling. | **proposed** |
| H2 | 10 | `governing()` resolves contradictions by **confidence label alone**, tie-broken by oldest id. A confidence label thereby "earns belief on its own" — exactly what Axiom 10 forbids. | `generate-views.mjs` `governing()` / `GOVERNANCE_PRECEDENCE` | Weight by **evidence** (source/provenance), most sharply on disconfirmation; confidence label is a tiebreak, not the arbiter. Requires an evidence signal (schema field or heuristic). | **needs-ratification** |
| H3 | 12 | Never-resolvable contradictions either force a false governor or accumulate as permanent noise that dilutes the active set. | `classify()` / `assembleContext` | A **dormancy** state: park a contradiction that cannot be resolved, preserving both sides without forcing a winner or cluttering active facts. | **needs-ratification** |
| H4 | 18 | `ratify` is pure per-item (`--ids`/`--all`). At scale this creates ratification fatigue, pushing the human toward rubber-stamping — surrendering the authority the axiom protects. | `runner.mjs` `planRatify`/`applyRatify` | **Delegated authority:** ratify by standing policy, sampling, or deferred review, so authority is exercised without per-item clicks. Authority stays human-held and reversible. | **needs-ratification** |
| H5 | 17 | A fact mis-routed into a weaker classification passes through a lower bar than its content warrants (category-misrouting to dodge scrutiny). | `evaluateCandidate` privacy/classification gate | Secret/sensitive mis-routing is **already blocked** (`scanSensitiveData` forces restricted/sensitive). Remaining gap: no integrity check that a claim's *category* matches its content beyond the secret axis. | proposed (partial) |
| H6 | 24 | No runner path to retract; retraction requires hand-editing, which invites silent history loss. | `runner.mjs` (no retract verb) | Axiom 24 is **already honored** — `classify()` keeps retracted/superseded/expired as `history`, never erased. Add an audited `retract` verb (sets `retracted_at` + reason) so withdrawal never tempts deletion. | proposed |
| H7 | 13 | Temporal fields (`valid_from`/`valid_to`) are shape-checked but their *plausibility* is not (e.g., far-future or pre-epoch dates enter unremarked). | `validate-claims.mjs` date checks | Add range/plausibility bounds and cross-field sanity to temporal validation. | needs-design |
| H8 | 15 | Concept forking / ownership disputes: two entities or predicates that name the same thing accumulate divergent claims with no reconciliation surface. | `reconcile.mjs` | Surface probable duplicate entities/predicates for human reconciliation. | needs-design |

## Notes on H2 / H3 / H4 (why they are not yet built)

These three change **behavior the human just ratified in the canon**. Per the
Axiom 18 model — *models may propose; authority over the record is human-held* —
they are written here as proposals and must be ratified (approach and design)
before implementation. Building them unilaterally would itself violate the axiom
they are meant to serve.

## What was hardened this pass

- **H1** — faithful contradiction rendering in the projection (Axiom 11), with a
  regression test.
- This register created as the standing home for the remaining items.
