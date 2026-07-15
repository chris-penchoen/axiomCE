---
title: AxiomCE Architecture
type: framework
classification: public
status: public-preview
updated: 2026-07-15
---

# Architecture

> **Authority.** This is a public, implementation-facing summary. The
> authoritative specification is the AxiomCE architecture in the Axiom canon
> (`06_ARCHITECTURE.md`); where the two differ, the canon governs. This document
> is a projection of that spec, not a competing source of truth.

## High-level model

AxiomCE separates durable human context from model execution.

```text
                    AxiomCE
                       |
       +---------------+---------------+
       |                               |
 Knowledge pillar               Cognitive-model pillar
 What is known?                 How should collaboration work?
       |                               |
 sources, claims,               policy, calibration,
 entities, reconcile,           adapters, evaluation spec
 generated views                       |
       +---------------+---------------+
                       |
              Current AI model
                       |
                  Task execution
```

The two pillars shown here are the two most visible planes of the canonical
model — the **knowledge plane** and the **collaboration (cognitive-model)
plane**. The full specification wraps three more planes around them (evidence,
governance, and execution); see the Axiom canon's `06_ARCHITECTURE.md`.

## Knowledge pillar

A durable chain from evidence to usable context:

```text
Raw sources
    |
Atomic claims
    |
Stable entities
    |
Reconciliation
    |
Generated views
```

Key properties:

- provenance is preserved;
- contradictions are not erased;
- temporal state is explicit;
- confidence is recorded, not guessed away;
- human-readable documents may be generated projections rather than hidden truth stores.

## Cognitive-model pillar

A portable specification for collaboration:

```text
Policy rules
    |
Relevant calibration cases
    |
Model-specific presentation adapter
    |
Model response
    |
Human-governed evaluation
```

The canonical policy describes the human. Adapters describe model quirks.

A model-specific failure should update that model's adapter, not silently rewrite the human profile.

## Governance boundary

Repository governance and collaborator governance remain separate:

- `AGENTS.md`-style rules govern how an agent modifies the repository.
- Cognitive-model policy governs how an agent works with the human.

Each atomic rule has one authoritative owner.

## Why plain text

The reference implementation uses Markdown, YAML front matter, JSONL, Git, and small zero-dependency validators.

This makes the system:

- auditable;
- diffable;
- portable;
- inspectable by humans;
- usable by different AI systems;
- and independent of a particular database or cloud service.