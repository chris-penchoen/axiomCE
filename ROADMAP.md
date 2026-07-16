---
title: Roadmap and Research Questions
type: framework
classification: public
status: public-preview
updated: 2026-07-16
---

# Roadmap and Research Questions

The AxiomCE roadmap is evidence-driven rather than feature-driven.

AxiomCE has already been extracted as a public framework (see [CURRENT_STATUS.md](CURRENT_STATUS.md)). The open question is not *whether* extraction is possible, but *whether the extracted framework is production-ready*.

## Near-term: Hardening the Extracted Framework

- Audit and document all privacy boundaries for external use.
- Expand the sample beyond one calibration case to show multiple scenarios.
- Write external-adopter documentation (setup, extending schemas, integrating with other tools).
- Run the framework on 2–3 external test projects (with consent) to catch integration issues.
- Validate that schemas are stable and tolerate real-world variations.
- Confirm privacy properties hold under different data-sensitivity levels.

## Medium-term: Expanding Evidence

- Expand calibration corpus from 5 to 20+ meaningful cases.
- Cover diverse task domains: architecture, research, writing, scripting, planning, operational troubleshooting.
- Repeat cross-model comparisons across multiple cases and model families.
- Measure human cleanup required per model and task.
- Human-ratify useful evaluation observations.
- Confirm whether thin adapters measurably reduce model-specific failure modes.

## Long-term: Core Research Questions

- How much collaboration judgment is genuinely portable?
- Which preferences remain stable across domains and model families?
- How many calibration cases are needed before a policy becomes predictive?
- When is a failure about the human model versus the AI model?
- Can model adapters be generated from repeated evidence rather than hand-tuned?
- How should privacy classifications propagate into generated views and external prompts?
- What is the shelf-life of a calibration case? Does behavior drift require periodic re-calibration?

## Framework Readiness Threshold

The framework is suitable for external use when:

- ✅ Extraction is complete and schemas are stable (done).
- ✅ Privacy boundaries are clearly defined (done).
- ❓ External testing validates usability without framework changes (in progress).
- ❓ Sample documentation is clear and complete (in progress).
- ❓ Governance patterns are well-documented for extension (partial).
- ⏳ Privacy audit is complete and published (pending).

Roadmap priorities will shift based on early external feedback.