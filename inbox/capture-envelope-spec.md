---
title: Capture Envelope Spec — normalization contract
type: spec
classification: public
created: 2026-07-15
updated: 2026-07-15
status: draft
version: 0.1
source: framework-reference-example
---

# Capture Envelope Spec

The normalization contract for `tools/runner.mjs capture`. It defines how a model
MUST turn a conversation into a **candidate-claims envelope** so that meaning —
not merely structure — survives the transfer into the store.

Keywords **MUST**, **MUST NOT**, **SHOULD**, **MAY** are used per their ordinary
RFC-2119 sense.

## Why this exists

The runner is deterministic. It **guarantees**:

- structural validity (schema, enums, timestamps, id format) — `validate-claims`;
- privacy safety — never-store secrets are blocked everywhere, and sensitive
  data is blocked from any tracked (non-`private/`) claim;
- append-only lifecycle, stable id minting, and provenance on every claim.

The runner **cannot** guarantee **semantic fidelity**. A claim can be perfectly
valid and privacy-clean while still *lying* about what was said: a hedge recorded
as `confirmed`, a negation recorded as a positive, three facts fused into one, a
contradiction silently halved. The engine validates *structure*; it has no way to
know the *meaning* is wrong. Continuity requires preserving meaning, not merely
structure — that is the gap this contract closes. The normalizer (the model) is
the only party that saw the conversation; these rules bind it.

See `../kernel/BOOT.md` (layers, lifecycle, governance) and
`../kernel/ontology.yaml` (claim schema).

## Envelope format

- The envelope is a UTF-8 **JSONL** file: one JSON object (one candidate claim)
  per line. Blank lines and lines beginning `//` are ignored.
- Each candidate uses the claim schema in `../kernel/ontology.yaml`. It **MUST**
  carry `entity`, `predicate`, `value`, `confidence`, `classification`,
  `valid_from`, and `source`.
- It **MAY** omit `id` and `asserted_at`; the runner mints them. When `id` is
  omitted it **MUST** provide `id_domain` (a short id token, e.g. `gxd`) to mint
  from. `id_domain` is not part of the claim schema and is stripped on capture.
- It **MAY** carry `valid_to`, `supersedes`, and `note`.

## Fidelity rules (normative)

- **F1 — Assert state, not aspiration.** Record what is true *now*. A pilot,
  proposal, or intention **MUST NOT** be recorded as the established fact. If a
  real-world state actually changed, express it with `supersedes` (evolution) or
  `valid_to` (expiry) — never by overwriting.
- **F2 — Preserve negation.** An exclusion is itself a fact. Something ruled out
  **MUST** be recorded as an explicit "ruled-out" claim, and **MUST NOT** be
  emitted as a positive candidate. Dropping a `not` inverts the meaning.
- **F3 — Atomic decomposition.** One separately-queryable fact per claim. Distinct
  facts (e.g. three independent reasons) **MUST NOT** be fused into one `value`.
  Use distinct predicates.
- **F4 — Preserve contradiction; do not adjudicate.** When the source gives
  conflicting values for the same fact, emit them faithfully and let the engine
  surface the contradiction. The normalizer **MUST NOT** silently pick a winner.
  When two values coexist under different conditions (not a true conflict), use
  distinct predicates and record the relationship in `note`; when the source
  itself is unreconciled, add an `unresolved` claim naming the open question.
- **F5 — Confidence discipline.** `confidence` **MUST** reflect the speaker's
  actual epistemic stance. Hedges ("pretty sure", "might", "~60%") **MUST NOT** be
  upgraded to `confirmed`. `confirmed` requires an independent verifiable source;
  a first-person assertion is `user-stated`; a genuine unknown is `unresolved`.
- **F6 — Classification routing.** Sensitive personal data (pay, health, custody,
  bankruptcy figures, account numbers) **MUST** be classified `restricted` (or
  `sensitive`) so it routes to `private/`. It **MUST NOT** be filed `personal`/
  `public`. See `../DATA_CLASSIFICATION.md`.
- **F7 — Never-store.** Credentials, secrets, API keys, passwords, and full
  card/account numbers **MUST NOT** appear in any claim — not even under
  `private/`. Omit them entirely.
- **F8 — Independent temporal coordinates.** `valid_from` is when the fact is
  true *in the world*; `asserted_at` is when it was *recorded* (the runner fills
  it). These **MUST NOT** be collapsed into one date. Use `valid_to` for expiry
  and `supersedes` for resolved evolution.
- **F9 — Provenance.** Every claim's `source` **MUST** link back to the source
  record or conversation it came from. Per `../SOURCE_POLICY.md`, an AI-conversation
  import ceilings at `user-stated`; it never yields `confirmed` on its own.
- **F10 — Nuance survives in `note`.** Any caveat, condition, or scope the compact
  `value` cannot hold **MUST** be preserved in `note`. Narrative is never
  decomposed away.

## Ratification

Captured claims land **pending human ratification**. The runner never sets
`confirmed` on its own. Review the dry-run plan, then `--apply`; promote
confidence only when an independent source justifies it.

## Worked example

This example is fictional; it illustrates the rules, not any real entity. For a
conversation stating: production is still Hubspot while Webflow is only a ~60%
pilot; a self-hosted option is ruled out; three distinct migration drivers; a
$400 main ticket price with an unreconciled $350 early-bird; an Aug 15 launch
date the co-founder might move to the 22nd; a net-pay figure; and an admin
password — a conforming envelope:

```jsonl
{"id_domain":"acme","entity":"organization:acme-demo","predicate":"website-platform-pilot","value":"Webflow on a staging domain (not migrated to production)","confidence":"user-stated","classification":"personal","valid_from":"2026-07-15","source":"sample-conversation","note":"~60% likely to survive the pilot; production platform is still Hubspot (clm-acme-0001). Pilot, not a decision (F1, F5)."}
{"id_domain":"acme","entity":"organization:acme-demo","predicate":"website-platform-ruled-out","value":"Self-hosted option","confidence":"user-stated","classification":"personal","valid_from":"2026-07-15","source":"sample-conversation","note":"The co-founder killed the self-hosted option ~June 2026. Recorded as an exclusion, not a candidate (F2)."}
{"id_domain":"acme","entity":"organization:acme-demo","predicate":"migration-driver-email","value":"Current email campaigns are clunky","confidence":"user-stated","classification":"personal","valid_from":"2026-07-15","source":"sample-conversation","note":"One of three independent drivers (F3)."}
{"id_domain":"acme","entity":"organization:acme-demo","predicate":"migration-driver-cost","value":"Current platform is expensive at current volume","confidence":"user-stated","classification":"personal","valid_from":"2026-07-15","source":"sample-conversation"}
{"id_domain":"acme","entity":"organization:acme-demo","predicate":"migration-driver-control","value":"The co-founder wants more design control","confidence":"user-stated","classification":"personal","valid_from":"2026-07-15","source":"sample-conversation"}
{"id_domain":"acme","entity":"organization:acme-demo","predicate":"next-event-early-bird","value":"$350 early-bird for the first 5 signups","confidence":"user-stated","classification":"personal","valid_from":"2026-07-15","source":"sample-conversation","note":"Conditional; main price remains $400 (clm-acme-0002). Coexists, not a replacement (F4)."}
{"id_domain":"acme","entity":"organization:acme-demo","predicate":"next-event-pricing-status","value":"Unreconciled: $400 main vs $350 early-bird for first 5","confidence":"unresolved","classification":"personal","valid_from":"2026-07-15","source":"sample-conversation","note":"The owner has not reconciled the two prices (F4 open question)."}
{"id_domain":"acme","entity":"organization:acme-demo","predicate":"event-date","value":"Aug 15 (current plan)","confidence":"user-stated","classification":"personal","valid_from":"2026-07-15","source":"sample-conversation","note":"The co-founder floated moving it to Aug 22; not locked. Not confirmed (F5)."}
{"id_domain":"fin","entity":"finance:budget-demo","predicate":"net-pay","value":"[net-pay figure omitted from this spec — restricted]","confidence":"user-stated","classification":"restricted","valid_from":"2026-07-15","source":"sample-conversation","note":"Routed to private/ by classification (F6). Real figure lives only under private/."}
```

The admin password is **absent** by design (F7). No line collapses `valid_from`
and `asserted_at` (F8); every line carries `source` (F9); every caveat lives in
`note` (F10).
