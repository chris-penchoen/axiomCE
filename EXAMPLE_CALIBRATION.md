---
title: Example Calibration Case
type: calibration
classification: public
status: public-preview
updated: 2026-07-15
---

# Example Calibration Case

> This is a fictional, public-safe example of an AxiomCE calibration case. It does not contain private repository data.

## Case ID

`PUBLIC-CAL-001`

## Domain

PowerShell / operational delivery

## Situation

A user asks:

> Write a PowerShell script that exports inactive devices from a cloud directory.

## Uncalibrated response pattern

A poor response might:

- spend several paragraphs explaining what PowerShell is;
- use deprecated modules;
- omit pagination;
- provide pseudocode rather than an executable script;
- ignore devices with missing timestamps;
- omit validation and expected output;
- hide assumptions about permissions.

## Preferred response pattern

A calibrated response should:

1. State the recommended API and permission assumptions.
2. Provide a complete copy-paste-ready script.
3. Handle pagination and null timestamps.
4. Export a clean CSV.
5. Log failures and HTTP status where useful.
6. Explain only the tradeoffs that affect implementation.
7. Include a quick validation step.

## Policy concepts exercised

- Recommendation before tutorial.
- Executable artifact over general guidance.
- Anticipate blockers and edge cases.
- Distinguish verified facts from assumptions.
- Minimize future cleanup.
- Prefer current supported interfaces.

## Why the difference matters

Both responses may be technically informative.

Only the second reduces the user's implementation work and produces something operationally usable.

Calibration cases make that distinction explicit instead of expecting a model to infer it from vague instructions.