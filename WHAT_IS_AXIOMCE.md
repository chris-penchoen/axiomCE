---
title: What AxiomCE Is
type: framework
classification: public
status: public-preview
updated: 2026-07-15
---

# What AxiomCE Is

AxiomCE (the Axiom Continuity Engine) is a **model-agnostic operating environment for durable human-AI collaboration**. It is the engine layer that operationalizes the Axiom theory; axiomCE-sample is its reference implementation.

It is not an AI model, a chatbot, a vector database, or an agent framework. It is the persistent layer that sits around those systems so accumulated context and collaboration practices are not trapped inside any one vendor's hidden state.

AxiomCE asks two separate questions:

1. **What is true about the human and their world?**
2. **How should an AI collaborate effectively with that human?**

Those questions have different evidence models and therefore different architectures.

> **Planes vs pillars.** The two pillars below are the two most visible planes of
> the canonical model — the **knowledge plane** and the **collaboration
> (cognitive-model) plane**. The full Axiom specification wraps three more planes
> around them (evidence, governance, and execution); see the Axiom canon's `06_ARCHITECTURE.md` §5.
> These pillars are an implementation-facing projection, not a competing model.

## Knowledge pillar

The knowledge pillar manages factual and temporal state:

- immutable source material;
- atomic claims;
- stable entity identifiers;
- provenance;
- contradiction preservation;
- valid time versus learned time;
- confidence labels;
- reconciliation;
- generated human-readable views.

Old facts are not silently overwritten. Conflicting claims can coexist until evidence supports resolution.

## Cognitive-model pillar (collaboration)

The cognitive-model pillar describes collaboration policy:

- delivery expectations;
- decision heuristics;
- recurring friction;
- optimization priorities;
- interaction rules;
- model-specific presentation adapters;
- calibration cases showing poor versus preferred output.

Each policy rule has one authoritative owner and a stable identifier so examples and evaluations can reference it without duplicating it.

## Evaluation status

The architecture includes a human-governed evaluation design. Model outputs may be compared against policy and calibration cases, but model-generated scores remain estimates until human-ratified.

The evaluation loop is designed, not yet an autonomous operating subsystem.