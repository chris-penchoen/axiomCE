---
title: Decision Framework
type: governance
classification: personal
created: 2026-07-14
updated: 2026-07-14
---

# DECISION_FRAMEWORK.md

The standard shape for any non-trivial decision recorded in an AxiomCE implementation. Use
`templates/decision.md` to create one. Store decisions near their domain (e.g.,
a business or `vehicles/` domain) or in `projects/`, and link them from
`CURRENT_CONTEXT.md` while active.

A decision record exists to make **future re-litigation cheap**: capture enough
that you (or a future agent) can see *why* and know *when to revisit* — without
re-arguing settled questions.

## The seven fields

1. **Context** — What situation forces a choice? What's the trigger and the
   stakes? Keep it factual; label confidence per `AGENTS.md` §4.
2. **Constraints** — Hard limits the decision must respect (budget, time,
   invariants from your profile/constraints doc, classification/privacy rules). Separate
   *hard* constraints from *preferences*.
3. **Options** — The realistic candidates considered, including "do nothing."
   Name at least two.
4. **Evidence** — Facts and sources bearing on the choice, each cited and
   reliability-rated per `SOURCE_POLICY.md`. Note what you *don't* know.
5. **Tradeoffs** — For the leading options, the cost/benefit and what each
   sacrifices. Be explicit about risk to invariants.
6. **Decision** — What was chosen, by whom, and the one-line rationale. State
   the confidence level of the decision itself.
7. **Revisit date** — When to re-evaluate, or the signal/trigger that should
   force a revisit earlier. Every decision gets one.

## Rules

- **No decision without a revisit date or trigger.** Open-ended choices rot.
- **Record the losing options.** They stop you re-opening settled debates.
- **Decisions are superseded, not deleted.** A reversal creates a new record
  that `Supersedes:` the old one (see `SOURCE_POLICY.md` §5–6).
- **Small, reversible decisions** can be logged briefly inline in a project log.
  **Large or invariant-touching decisions** get a full record and, per the
  user's operating rules, a cooldown before execution.
- Link evidence to `sources/` records; link affected people/projects.

## Minimal inline form (for small decisions)

> **Decision (YYYY-MM-DD):** chose X over Y because Z. Revisit: `<date/trigger>`.
