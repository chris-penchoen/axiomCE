---
title: System Diagrams
type: framework
classification: public
status: public-preview
updated: 2026-07-15
---

# System Diagrams

## Traditional model-bound personalization

```text
Human
  |
  v
Single AI product
  |
  v
Hidden memory and interaction history
```

If the product or model changes, much of the accumulated working relationship may not move with it.

## AxiomCE design objective

```text
                 AxiomCE
        +-----------+-----------+
        |                       |
  Durable knowledge       Collaboration policy
        |                       |
        +-----------+-----------+
                    |
        +-----------+-----------+
        |           |           |
       GPT        Claude      Gemini
        |           |           |
        +-----------+-----------+
                    |
               One human
```

The same canonical human model is supplied to multiple execution engines.

> **Planes vs pillars.** The two branches above (durable knowledge, collaboration
> policy) are the two most visible of the five canonical planes — knowledge and
> collaboration. Evidence, governance, and execution planes are also part of the
> full model; see the Axiom canon's `06_ARCHITECTURE.md` §5. These diagrams are implementation-facing
> projections of that specification.

## Human-governed adaptation

```text
Policy + relevant calibration
              |
              v
          Model output
              |
              v
      Evaluation observation
              |
              v
        Proposed correction
              |
              v
         Human ratification
              |
              v
     Canonical update, if approved
```

The human approval step is intentional. Models may propose changes but do not autonomously redefine the human.