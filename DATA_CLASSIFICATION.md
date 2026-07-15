---
title: Data Classification
type: governance
classification: personal
created: 2026-07-14
updated: 2026-07-14
---

# DATA_CLASSIFICATION.md

Every file declares a `classification` in front matter. This file defines the
classes, what belongs in each, and **whether Git may track it**. When unsure,
classify **up** (more restrictive).

## Classes

### 1. Public
- **What:** Non-personal, shareable reference material. Evergreen how-tos,
  general knowledge, public specs, links.
- **Examples:** A note summarizing a public reference article; a generic
  trail-prep checklist.
- **Git:** ✅ Tracked.
- **Homes:** `knowledge/`, `templates/`.

### 2. Personal
- **What:** Ordinary personal information that is not damaging if leaked but is
  still yours. Preferences, project notes, general plans, non-precise location.
- **Examples:** Project status, a person's first name + relationship, a small business's ops
  notes, career skill goals.
- **Git:** ✅ Tracked (this is the repo's default working class).
- **Homes:** most content dirs.

### 3. Sensitive
- **What:** Information that could cause real harm, embarrassment, or targeting
  if leaked. Handle with care; minimize precision.
- **Examples:** Home address, family members' details, finances at the
  line-item level, VINs/plates, health-adjacent notes, phone numbers.
- **Git:** ⚠️ Tracked **only if** the repo remains private AND the user has
  opted in. Default: **prefer `private/`**. Detailed sensitive records (real
  amounts, dates, identifiers) live in `private/` as Restricted; a tracked
  **stub** (classified Personal) may remain at the original path for
  discoverability, pointing to the local-only record without reproducing it. If
  tracked, never include Never-store elements.
- **Homes:** `family/`, `finance/`, sensitive parts of `home/`, `vehicles/`.

### 4. Restricted
- **What:** Highly sensitive personal data that should essentially never sit in
  a synced repo. Precise financial detail, identifiers, anything legally
  sensitive but not outright forbidden.
- **Examples:** Full account/statement detail, government ID numbers (non-secret
  contexts), custody/legal case notes, detailed family / finance / home /
  vehicle records with exact figures, dates, and identifiers.
- **Git:** ❌ **Not tracked.** Store in `private/` only (Git-excluded).
- **Authoritative & local:** `private/` records are the **source of truth** for
  local reasoning. Git exclusion means *do not publish*, not *do not use*.
  Agents load `private/INDEX.md` and include `private/` in normal local search
  (see `AGENTS.md` §3.1). Preserve full context here — do **not** water it down.

### 5. Never-store
- **What:** Data that must **not be written into this repository at all**, in
  any directory, tracked or not.
- **Examples:** Passwords, secrets, API keys/tokens, banking credentials, full
  card numbers, tax documents, medical records, legal account numbers,
  employer-confidential material.
- **Git:** ❌ Never. **Do not create the file.** If encountered, refuse and tell
  the user to use their password manager / proper vault.

## Quick reference

| Class | Leak impact | Git tracked? | Default home |
|-------|-------------|--------------|--------------|
| Public | None | ✅ Yes | `knowledge/`, `templates/` |
| Personal | Low | ✅ Yes | most dirs |
| Sensitive | Moderate/High | ⚠️ Only if private repo + opt-in; prefer `private/` | `family/`, `finance/`, `vehicles/` |
| Restricted | High | ❌ No — `private/` only | `private/` |
| Never-store | Severe | ❌ Never — do not write | (nowhere) |

## Rules

- The **file's** `classification` must be at least as strict as the most
  sensitive datum inside it. No Sensitive data in a Public file.
- `private/` is excluded by `.gitignore` (except `.gitkeep`). Restricted content
  lives there. See `PRIVATE_DATA.md`.
- Redact where possible: store "paid from checking" not an account number;
  "2019 JKU, WA plate on file" not the plate string, unless in `private/`.
- When migrating a file up in classification, move it to an appropriate home and
  update links.
- **Enforcement:** `tools/privacy-check.mjs` blocks Restricted-classified files
  in tracked paths, Never-store secrets anywhere, and heuristically-detected
  actual sensitive data (DOB, SSN, exact salary, custody-order language, medical
  diagnoses, bankruptcy account detail, account numbers) in tracked Markdown. It
  also verifies `private/` is `.gitignore`-excluded and (once Git exists) that no
  file under `private/` is tracked. Governance/policy docs are exempt from the
  heuristic scanner because they necessarily describe these categories.
