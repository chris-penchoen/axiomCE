---
title: AxiomCE Preview
type: index
classification: public
status: public-preview
updated: 2026-07-15
---

# AxiomCE

**The Axiom Continuity Engine - a portable, model-agnostic environment for durable human-AI collaboration.**

## Where this sits: the three layers

- **Axiom** - the invariant theory: what continuity is and why it matters (see the Axiom canon in the parent directory).
- **AxiomCE** - the Continuity Engine that operationalizes Axiom. **This package documents AxiomCE.**
- **axiomCE-sample** - the reference implementation: a public, data-free sample instance of AxiomCE that private implementations can be derived from.

AxiomCE began as a practical problem: preserve years of useful context and working habits when moving between AI systems. It became a broader architecture for separating:

- what is known about a person and their world;
- how an AI should collaborate with that person;
- what belongs to the human versus the model;
- what is implemented versus still hypothetical;
- and what must remain portable across vendors and model families.

> **AxiomCE treats long-term human-AI collaboration as production infrastructure rather than application state.**

The design objective is simple:

> **There is one human. Models adapt. Not the human.**

That objective is not yet proven. The reference implementation (axiomCE-sample) demonstrates a working knowledge layer, a cognitive-model policy layer, calibration cases, validators, and an early cross-model comparison. Long-term portability remains an active hypothesis.

> **Terminology.** "Cognitive-model" is this project's implementation name for what
> the Axiom canon calls the **collaboration plane** (the durable knowledge of how
> an AI should collaborate with the human). Likewise the "knowledge pillar" is the
> canon's **knowledge plane**. The canon terms are authoritative; see the
> terminology equivalence table in the Axiom canon's `RECONCILIATION.md`
> (term index: `GLOSSARY.md`).

## Start here

- [What AxiomCE is](WHAT_IS_AXIOMCE.md)
- [Why it exists](WHY_IT_EXISTS.md)
- [Architecture](ARCHITECTURE.md)
- [System diagrams](SYSTEM_DIAGRAMS.md)
- [Ownership model](OWNERSHIP_MODEL.md)
- [Current status](CURRENT_STATUS.md)
- [Example calibration case](EXAMPLE_CALIBRATION.md)
- [Roadmap and research questions](ROADMAP.md)

## Public-preview scope

This package is deliberately sanitized. It contains no personal claim records, private source material, family information, financial data, employer-confidential context, raw chat exports, or private calibration examples.

A private personal instance and this public AxiomCE framework are not the same artifact.