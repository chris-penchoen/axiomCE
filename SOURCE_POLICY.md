---
title: Source Policy
type: governance
classification: personal
created: 2026-07-14
updated: 2026-07-14
---

# SOURCE_POLICY.md

How an AxiomCE implementation handles sources, citations, and conflicting or stale facts. This
file supports the epistemic labeling rules in `AGENTS.md` §4.

## 1. Source reliability levels

Rank every source. Record the level in the source record (`type: source`) and
carry it into any fact derived from it.

| Level | Name | Description | Examples |
|-------|------|-------------|----------|
| **R1** | Primary record | Firsthand, verifiable artifact. | Receipt, invoice, VIN plate, odometer photo, signed doc, direct measurement. |
| **R2** | Reliable secondary | Reputable, verifiable, but not firsthand. | Official docs, manufacturer specs, reputable reference sites, bank statement summary. |
| **R3** | User statement | The user asserted it; not yet verified. | "I paid ~$400 for that lift." |
| **R4** | Third-party / anecdotal | Someone else said it; unverified. | A friend's recommendation, forum post. |
| **R5** | AI-generated / model output | Produced by an AI, including imported chat summaries. | ChatGPT/Claude conversation exports. |

Higher number = lower reliability. **A fact's confidence can never exceed what
its source level supports:** R1/R2 → up to `confirmed`; R3 → `user-stated`;
R4 → `unresolved` or `user-stated` (attributed); R5 → `inferred`/`unresolved`,
never `confirmed`.

## 2. Citation format

Cite inline and/or in front matter.

- **Inline:** `(source: <short id>, R<level>, <YYYY-MM-DD>)`
  e.g. `(source: printful-invoice-0412, R1, 2026-07-01)`
- **Front matter:** `source: <short id>` and optionally `confidence: <label>`.
- **Full record:** create a file in `sources/` from
  `templates/source-record.md` for any source you'll reference more than once
  or that needs provenance. Link facts to it.

Every `confirmed` fact **must** name a source. No source → not `confirmed`.

## 3. Imported AI-conversation summaries

Summaries imported from AI chats (e.g., ChatGPT/Claude) are **R5** by default.

- Import them into `sources/` (or `inbox/` first) as a source record marked
  `type: source`, `classification` per content, reliability **R5**.
- Facts extracted from them start at `confidence: user-stated` **only if** the
  user personally asserted them in that chat; otherwise `inferred`/`unresolved`.
- **Never treat an AI summary as `confirmed`.** Model output is not evidence.
- Preserve attribution: note it came from an AI conversation, with date.
- Before relying on such a fact for a real decision, upgrade it by finding an
  R1/R2 source, then update the label and cite the new source.

## 4. Stale facts

- Time-sensitive facts (prices, odometer, balances, statuses) should carry a
  `<YYYY-MM-DD>` "as-of" date.
- A fact older than its natural refresh window is **stale**: keep it, but treat
  it as `estimate` or `unresolved` until re-verified.
- When re-verifying, **supersede** (see §5) rather than overwrite.

## 5. Conflicting facts

When two facts disagree:

1. Prefer the **higher reliability** source (lower R number).
2. If equal reliability, prefer the **more recent** with an as-of date.
3. If still unresolved, mark **both** `confidence: unresolved`, link them to
   each other, and add an entry under Open Questions in `CURRENT_CONTEXT.md`.
4. Never silently delete the losing fact — move the superseded one to
   `archive/` with a link to the survivor, or mark it `status: superseded`.

## 6. Supersession record (minimum)

When replacing a fact, the new file should include:

- `Supersedes:` link to the old fact.
- The old file gets `status: superseded` + `Superseded-by:` link, then moves to
  `archive/` if no longer active.
