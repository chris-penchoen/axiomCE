---
title: Private Data Policy
type: governance
classification: personal
created: 2026-07-14
updated: 2026-07-14
---

# PRIVATE_DATA.md

What must **never** be committed to this repository, and where sensitive data
goes instead. This complements `DATA_CLASSIFICATION.md`.

## Never commit (Never-store class)

Do not write these into the repo **at all** — not even in `private/`. Use a
password manager or proper vault:

- Passwords, passphrases, PINs.
- Secrets, API keys, tokens, OAuth/session credentials.
- Banking credentials, full card numbers, full account numbers, routing +
  account combinations.
- Tax documents, medical records.
- Legal account numbers / sealed case identifiers.
- Employer-confidential material.

If an agent is asked to store any of the above, it must **refuse** and say why.

## Local-only (Restricted class) → `private/`

Store in `private/` (Git-excluded) when the data is needed locally but must not
sync:

- Precise financial detail (statement-level).
- Government ID numbers in non-secret contexts.
- Custody / legal notes.
- Detailed family, finance, health, legal, home, and vehicle records with exact
  figures, dates, relationships, history, and constraints.
- Any Sensitive data the user chooses not to track in Git.

`private/` is **authoritative local context**, not hidden data: it is loaded via
`private/INDEX.md` and used in normal local reasoning (see `AGENTS.md` §3.1).
Git exclusion means *do not publish*, never *do not use*. Preserve full,
useful context here — do not sanitize it into vague abstractions. Sensitive
content must not be copied into tracked files, commits, public output, or
external MCP calls unless the owner explicitly asks.

The `private/` directory is excluded by `.gitignore` (except `.gitkeep`).
**Verify `git status` never lists real files under `private/`.**

## Sensitive-but-trackable (only if repo stays private + opt-in)

Home address, family details, VINs/plates, phone numbers may be tracked **only**
if the repository remains private and the user opts in — otherwise redact and
keep them in `private/`. See `DATA_CLASSIFICATION.md`.

## Before any commit — checklist

1. `git status` shows no files under `private/` (besides `.gitkeep`).
2. No Never-store elements anywhere in staged files.
3. Each staged file's `classification` matches its most sensitive content.
4. Sensitive data is redacted unless private-repo + opt-in.
5. `node tools/privacy-check.mjs` passes (also wired as a pre-commit hook in
   `tools/hooks/pre-commit`).
