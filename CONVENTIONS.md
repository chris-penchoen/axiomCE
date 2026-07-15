---
title: Conventions
type: governance
classification: personal
created: 2026-07-14
updated: 2026-07-14
---

# CONVENTIONS.md

Naming and formatting conventions for an AxiomCE implementation. This is a support file for
`AGENTS.md` — where they appear to conflict, `AGENTS.md` wins. The goal is that
any future agent produces files that look like the ones already here, so the
repo stays machine-checkable and boring.

Several of these rules are enforced by `tools/validate.mjs`; the rest are
conventions an agent is expected to follow.

## 1. File names

- **Root governance / operating docs:** `SCREAMING_SNAKE_CASE.md`
  (`AGENTS.md`, `USER_PROFILE.md`, `CURRENT_CONTEXT.md`, `SOURCE_POLICY.md`,
  `DATA_CLASSIFICATION.md`, `DECISION_FRAMEWORK.md`, `PRIVATE_DATA.md`,
  `CONVENTIONS.md`, `CHANGELOG.md`, `REVIEW.md`).
- **Content files:** `kebab-case.md` — lowercase, hyphen-separated
  (`vehicle-01.md`, `monthly-expenses.md`, `team-roster.md`).
- **Directory index:** each directory's index is `README.md` with
  `type: index`. It describes the directory's purpose and (ideally) links its
  contents. It is a real file — no placeholders.

## 2. Front matter (the single source of truth)

Every content file starts with a YAML front-matter block. Required keys:
`title`, `type`, `classification`, `updated`. Recommended: `created`, `status`,
`source`, `confidence`, `tags`.

- **Front matter is authoritative.** Do **not** restate a front-matter value in a
  body heading (no `## Classification`, `## Confidence`, or `## Status` section
  that merely echoes the front matter). Body sections are for content the front
  matter cannot hold (rationale, notes, a revisit date, a log).
- **Dates** are ISO `YYYY-MM-DD`. No placeholders in real files (templates may
  keep `<YYYY-MM-DD>`). Enforced by the validator.
- Bump `updated:` on every substantive edit.

## 3. `type` values

Use an existing `type` where one fits; introduce a new one only when nothing
does. In use today:

`governance`, `index`, `profile`, `context`, `changelog`, `review`, `fact`,
`decision`, `person`, `project`, `event`, `source`, `vehicle`,
`maintenance-record`, `purchase`, `recurring-bill`, `expense`, `policy`
(cognitive-model rule documents), `calibration` (cognitive-model calibration
cases).

## 4. `status` values

`status` is optional. Prefer this shared base vocabulary; a domain template may
extend it where the domain genuinely needs it (e.g. an event is
`planned|confirmed|completed|cancelled`), but do not invent synonyms for states
that already exist here:

- **Lifecycle (most files):** `active`, `paused`, `done`, `archived`,
  `superseded`.
- **Decisions:** `open`, `decided`, `revisit`, `superseded`.
- **Inbox items:** `new`, `triaged`, `archived`.

When a file is retired, set `status` to `superseded` or `archived` and move it to
`archive/` (see `AGENTS.md` §7). Do not delete.

## 5. `tags`

- Lowercase `kebab-case`, in a single-line array: `tags: [acme, website]`.
- Prefer reusing an existing tag over coining a near-duplicate
  (`acme`, not `Acme`/`ac-me`).

## 6. Confidence labels (inline form)

Front matter carries `confidence: <label>` where `<label>` is one of
`confirmed | user-stated | inferred | estimate | unresolved` (see `AGENTS.md`
§4).

Inline in prose, mark a claim with the **label in parentheses** — optionally
with a short basis after a colon or dash. Write:

- `(user-stated)`
- `(estimate: ±20%)`
- `(inferred from A + B)`
- `(confirmed: receipt 2026-07-01)`

Do **not** prefix the word "confidence" inside the parentheses (i.e. avoid the
`` `(confidence: user-stated)` `` form). The validator flags that variant.

## 7. Intra-repo references

Point at other files with either a real Markdown link or a bare relative path —
**both are validated** by `tools/validate.mjs`, so keep them resolvable:

- Markdown link: `` [Person](./templates/person.md) `` — preferred in prose.
- Bare relative path: `./templates/person.md` — acceptable in "Related" lists.

Use `./` or `../` relative paths. Do not use absolute paths. When you rename or
move a file, run the validator and fix every reference it reports.

## 8. What the validator enforces

`node tools/validate.mjs` currently checks: required front-matter keys present
and non-empty; ISO dates (no placeholders outside `templates/`); allowed
`classification`; resolvable Markdown links **and** bare relative references; and
the canonical inline confidence form. Run it (and `node --test "tools/*.test.mjs"`)
before finishing any change.
