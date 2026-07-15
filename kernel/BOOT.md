---
title: AxiomCE Kernel — Boot Spec
type: kernel
classification: public
created: 2026-07-14
updated: 2026-07-14
---

# kernel/BOOT.md — read this first

This is the kernel contract for an **AxiomCE implementation** — a hybrid
Markdown + JSONL continuity store. It does **not** replace canonical records. Any frontier
model can become fluent in the whole store by reading this file plus
`kernel/ontology.yaml`. No database, no embeddings, no graph engine, no service,
no runtime dependency — plain UTF-8 text and one Node script.

## The layers (source-of-truth precedence)

1. **Raw imports** (`sources/`, and any local-only raw imports under `private/`) — **immutable**.
   Verbatim provenance. Never edited.
2. **Canonical records** (the ordinary `*.md` files: `projects/example.md`,
   `private/vehicles/vehicle-01.md`, …) — **human-editable sources of truth** for
   narrative knowledge. Prose is not decomposed into triples; nuance lives here.
3. **Claims** (`claims/*.jsonl`, `private/claims/*.jsonl`) — **append-only**
   atomic facts. Introduced *only* for facts that are atomic, time-varying,
   conflicting, decision-relevant, or queryable (e.g. a price, a condition, a
   platform choice, a measurement). Never overwritten; superseded or retracted.
4. **Entities** (`entities/*.md`, `private/entities/*.md`) — stable identity +
   pointers. The key is the opaque `entity_id` (e.g. `organization:acme`), not
   the filename or display name.
5. **Views** (`views/*.view.md`, `private/views/*.view.md`) — **generated
   outputs, DO NOT EDIT**. Produced by `tools/generate-views.mjs` from claims +
   entities. Regenerable and disposable.

Canonical records (layer 2) may *summarize* claims but must **never silently
overwrite claim history**. When a canonical record and a claim disagree, the
claim log is the audit trail; reconcile explicitly.

## How to read a claim

Each line of a `.jsonl` file is one JSON object:

- `id` — stable claim id, e.g. `clm-acme-0002`.
- `entity` — the `entity_id` this fact is about.
- `predicate` — a short kebab-case slug (open vocabulary, documented per entity).
- `value` — the fact, as compact prose or a scalar. **Not** a rigid triple.
- `confidence` — `confirmed | user-stated | inferred | estimate | unresolved`.
- `classification` — `public | personal | sensitive | restricted`.
- `valid_from` / `valid_to` — when the fact is true **in the world** (`valid_to`
  null = still current; a past `valid_to` = expired).
- `asserted_at` / `retracted_at` — when we **recorded** / **withdrew** it.
- `supersedes` — id of a claim this one replaces (resolved evolution).
- `source` — a source-record id (e.g. `import-2026-06-01`) or canonical
  entity id. **Every claim must link back** to a raw source or canonical record.
- `note` — optional free prose. Narrative is never decomposed away.

### Active vs. history

A claim is **active** unless it is retracted (`retracted_at` set), superseded
(another claim's `supersedes` names it), or expired (`valid_to` in the past).

- **Two active claims on the same `entity`+`predicate` = a contradiction.** The
  generator surfaces it under "Contradictions" rather than silently choosing.
- A clean update uses `supersedes` (old claim moves to History).

## Privacy model (two mechanisms, both required)

1. **Per-record classification metadata** — the `classification` field on every
   claim and entity.
2. **Physical placement** — anything `restricted` (and, by policy, sensitive
   material the owner chooses not to track) lives under `private/`, which is
   `.gitignore`-excluded. `private/` is **authoritative local context**, not
   hidden data (see `AGENTS.md` §3.1).

The generator writes a `restricted`/`sensitive` entity's view into
`private/views/`; only `public`/`personal` views land in tracked `views/`.
Restricted values must never be copied into tracked files.

## Invariants (do not break)

- Claims are **append-only**. To change a fact, append a new claim (with
  `supersedes` or a fresh `valid_from`) — never edit or delete a past line.
- Views are **generated**; never hand-edit a `*.view.md`. Regenerate instead.
- Every claim carries a `source`.
- Agents perform normalization from prose into claims. The owner does not hand-author
  claim envelopes during normal use.

## Regenerate the views

`node tools/generate-views.mjs` — deterministic; overwrites every `*.view.md`
from the current claims + entities. Add `--check` to fail (exit 1) if any view
is stale instead of writing.

### When a predicate is contradicted, which claim governs?

A view lists every active claim under "Contradictions" and also names the
**governing** one by this precedence:

`confirmed > user-stated > inferred > unresolved > estimate` (ties → lowest id).

Note the deliberate ordering: an explicit **`unresolved` safety guard OUTRANKS
an `estimate`**. "We do not know the net pay" must not be overridden by an
optimistic guess. Governance decides what a downstream agent should *rely on*;
it never deletes the losing claims.

## Tooling (all zero-dependency Node — no db, embeddings, service, or network)

| Command | Checks |
|---|---|
| `node tools/validate.mjs` | Markdown front matter, links, dates, classification |
| `node tools/validate-claims.mjs` | `.jsonl` claim schema/enums/timestamps/ids, entity + supersedes references, duplicate ids, malformed lines; `.yaml` well-formedness |
| `node tools/privacy-check.mjs` | leak scan of tracked `.md`/`.jsonl`/`.yaml` (restricted-in-tracked, secrets, heuristic personal-data). `private/` is skipped by design |
| `node tools/generate-views.mjs [--check]` | build / staleness-check the `*.view.md` projections |
| `node tools/reconcile.mjs` | divergence between canonical prose, active claims, and generated views |
| `node tools/runner.mjs project` / `capture` | project a portable context package for a fresh model / capture an agent-normalized candidate-claims envelope back into the store (see below) |

`validate-claims` inspects the **whole store** (tracked + private) for structural
soundness. `privacy-check` scans **tracked files only** — `private/` is
git-excluded and is *allowed* to hold restricted data, so scanning it as a
"leak" would be wrong.

### Closing the loop: the runner (memory transfer)

The tools above keep the store *sound*; `tools/runner.mjs` makes it *adaptive* by
carrying continuity in and out of a conversational AI. It is a deterministic,
model-agnostic harness — it **never calls a model API**. The model does the
interpretation; the runner does the deterministic part (routing, lifecycle,
privacy, provenance, id minting), preserving every invariant above.

- `node tools/runner.mjs project [--entity <id>]... [--adapter gpt|gemini]` —
  assemble the smallest authoritative **context package** (active claims +
  current context + open questions + collaboration policy) to hand a fresh model.
  Prints to stdout by default. Public/personal only unless `--include-private`,
  which requires `-o <path under private/>` (restricted content must never reach
  stdout or a tracked file). The output carries a reproducibility manifest.
- `node tools/runner.mjs capture <envelope.jsonl> [--apply]` — take an
  **agent-normalized candidate-claims envelope** (what a model extracted from a
  conversation; same claim schema, may omit `id`/`asserted_at` and instead carry
  an `id_domain` token to mint from), validate it structurally, privacy-gate it
  (never-store secrets always block; sensitive data blocks a *tracked* claim),
  route it to the correct append-only log, and mint stable sequential ids.
  Defaults to a **dry-run**; `--apply` appends. Captured claims land **pending
  human ratification** — the runner never marks anything `confirmed` on its own.

The `capture` envelope is exactly the normalization step the invariant above
names ("Agents perform normalization from prose into claims"): a model reads the
conversation and emits the envelope; the human ratifies the result.

### Reconciliation is explicit, never fuzzy

`reconcile.mjs` does **no** semantic comparison. It reads a manifest
(`reconcile/manifest.jsonl` + `private/reconcile/manifest.jsonl`) whose lines
declare which canonical fields are claim-backed:

`{ "entity": …, "predicate": …, "canonical": <prose file>, "token": <literal string> }`

For each entry it reports `MISSING_CLAIM`, `STALE_CANONICAL` (the `token` is not
present in the named prose file), `UNRESOLVED_CONTRADICTION`, or `STALE_VIEW`. It
**never rewrites canonical prose** — findings are resolved by a human or agent
appending claims / editing prose deliberately. Fields left out of the manifest
are simply not reconciled (opt-in coverage).

## Scope

The framework ships with an **empty store**: no entities, claims, or domains. An
implementation populates `entities/`, `claims/`, and its own domain folders, and
declares reconciliation coverage in `reconcile/manifest.jsonl` opt-in.

## Second pillar: the cognitive model

Everything above is the **knowledge pillar** — *what is known about the owner's
world*, validated by evidence/provenance. An AxiomCE implementation has a second, independent
pillar: `cognitive-model/` — *how an AI should collaborate with the owner*, validated
by repeated correction and calibration. It is normative policy (stable
`CM-*` rule IDs) that doubles as an evaluation rubric. It does **not** use the
claim schema and is **not** a runtime dependency; model-based evaluation is
external. Structural checks: `node tools/validate-cognitive.mjs`. Start at
[`../cognitive-model/README.md`](../cognitive-model/README.md).
