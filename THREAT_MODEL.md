---
title: Threat Model and Engine Hardening Register
type: framework
classification: public
status: draft
created: 2026-07-17
updated: 2026-07-18
source: adversarial pass over the Axiom Canon (2026-07-16/17)
confidence: user-stated
---

# Threat Model and Engine Hardening Register

This is the engine's home for **mechanism hardening** — the work of making the
runner enforce what the canon *requires*. It exists because the Axiom Canon
stays a set of standing concepts; it does not carry a threat-model section
(that would bloat it). Clarity-only wording fixes go to the canon; mechanism
hardening lands here and in `tools/`.

## Scope

- **In scope:** ways an *honest actor* can weaponize a legitimate mechanism —
  dilution, downplaying, mis-routing, forced false resolution, ratification
  fatigue. These are design gaps in the engine, not misuse.
- **Out of scope (ruled):** a *dishonest actor* forging provenance or sources.
  The runner records derivation history; it does not adjudicate whether a
  human-supplied source is truthful. Forged-provenance defense is a separate
  concern and is deliberately excluded here.

## The one property the runner cannot enforce

The runner guarantees **structure** and **privacy**. It **cannot** guarantee
**meaning**. Only the model saw the source conversation, so only the model can
preserve a hedge, a negation, or an atomic fact. The capture-envelope spec
(`inbox/capture-envelope-spec.md`, rules F1–F10) binds the model; the runner
cannot detect a dropped negation or an inflated confidence. Every item below
that touches meaning is therefore *mitigation*, not *enforcement*.

## Register

Status legend: **done** · **proposed** (implemented this pass, pending review) ·
**needs-ratification** (design decision that changes ratified canon behavior;
per Axiom 18 a model proposes, the human ratifies — not yet built).

| # | Axiom | Threat | Location | Fix | Status |
|---|-------|--------|----------|-----|--------|
| H1 | 11 | Live contradiction downplayed to a single claim to "rely on", hiding disagreement from the next model. | `runner.mjs` `assembleContext` (contradiction render) | Render as **UNRESOLVED**, show every side in proportion, label the pick a safety-default, not a ruling. | **proposed** |
| H2 | 10 | `governing()` resolves contradictions by **confidence label alone**, tie-broken by oldest id. A confidence label thereby "earns belief on its own" — exactly what Axiom 10 forbids. | `generate-views.mjs` `governing()` / `GOVERNANCE_PRECEDENCE` | Weight by **evidence** (source/provenance), most sharply on disconfirmation; confidence label is a tiebreak, not the arbiter. Requires an evidence signal (schema field or heuristic). | **needs-ratification** |
| H3 | 12 | Never-resolvable contradictions either force a false governor or accumulate as permanent noise that dilutes the active set. | `classify()` / `assembleContext` | A **dormancy** state: park a contradiction that cannot be resolved, preserving both sides without forcing a winner or cluttering active facts. | **needs-ratification** |
| H4 | 18 | `ratify` is pure per-item (`--ids`/`--all`). At scale this creates ratification fatigue, pushing the human toward rubber-stamping — surrendering the authority the axiom protects. | `runner.mjs` `planRatify`/`applyRatify` | **Delegated authority:** ratify by standing policy, sampling, or deferred review, so authority is exercised without per-item clicks. Authority stays human-held and reversible. | **needs-ratification** |
| H5 | 17 | A fact mis-routed into a weaker classification passes through a lower bar than its content warrants (category-misrouting to dodge scrutiny). | `evaluateCandidate` privacy/classification gate | Secret/sensitive mis-routing is **already blocked** (`scanSensitiveData` forces restricted/sensitive). Remaining gap: no integrity check that a claim's *category* matches its content beyond the secret axis. | proposed (partial) |
| H6 | 24 | No runner path to retract; retraction requires hand-editing, which invites silent history loss. | `runner.mjs` (no retract verb) | Axiom 24 is **already honored** — `classify()` keeps retracted/superseded/expired as `history`, never erased. Add an audited `retract` verb (sets `retracted_at` + reason) so withdrawal never tempts deletion. | proposed |
| H7 | 13 | Temporal fields (`valid_from`/`valid_to`) are shape-checked but their *plausibility* is not (e.g., far-future or pre-epoch dates enter unremarked). | `validate-claims.mjs` date checks | Add range/plausibility bounds and cross-field sanity to temporal validation. | needs-design |
| H8 | 15 | Concept forking / ownership disputes: two entities or predicates that name the same thing accumulate divergent claims with no reconciliation surface. | `reconcile.mjs` | Surface probable duplicate entities/predicates for human reconciliation. | needs-design |
| H9 | §3 / §3.2 | `private/` is **plaintext at rest**. Git-exclusion stops commits/publication but NOT: file/image backups, cloud sync, other local user accounts, malware/infostealers, or a lost/stolen unencrypted disk. Placing the store under a cloud- or corporate-synced profile path silently exfiltrates the private partition. | on-disk store (`private/`), deployment/OS | Keep the store OFF any synced/backed-up path; full-disk encryption; owner-only ACLs on `private/`; encrypt the partition at rest and in backups; Never-store class stays out entirely. | documented (operator action) — see §Data-at-rest confidentiality |

## Notes on H2 / H3 / H4 (why they are not yet built)

These three change **behavior the human just ratified in the canon**. Per the
Axiom 18 model — *models may propose; authority over the record is human-held* —
they are written here as proposals and must be ratified (approach and design)
before implementation. Building them unilaterally would itself violate the axiom
they are meant to serve.

## Data-at-rest confidentiality (the `private/` partition)

The register above is about **mechanism integrity** — honest-actor abuse of a
legitimate engine mechanism. This section is a **different threat class**:
the **confidentiality of `private/` data once it is legitimately on disk**. The
runner's fail-closed routing guarantees sensitive content lands in `private/`
and never in a tracked/publishable file (see `runner.mjs`, `DATA_CLASSIFICATION.md`,
`PRIVATE_DATA.md`). That is **publication** control. It says nothing about who
can read the bytes at rest.

### What git-exclusion does and does NOT protect

`private/` is excluded by `.gitignore` (except `.gitkeep`). That prevents the
data from being **committed, pushed, or published**. It is **plaintext on the
local filesystem** and therefore still exposed to every vector that does not go
through Git:

| Vector | Exposure | git-exclusion helps? |
|--------|----------|----------------------|
| File/image backups (Windows Backup, File History, third-party) | Backup copies `private/` verbatim, often to external or cloud targets. | No |
| **Cloud sync** (OneDrive/Dropbox/iCloud) if the store sits under a synced path | The provider uploads `private/` to its cloud. A **corporate** sync target (e.g. "OneDrive - Microsoft") additionally breaches **AGENTS.md §3.2** — personal data must never land on employer-synced storage. | No |
| Other local user accounts on the same machine | Default `Users` ACLs often let other accounts read the profile/tree. | No |
| Malware / infostealers | Read plaintext files with the user's own token; no vault to defeat. | No |
| Lost / stolen / decommissioned disk | Without full-disk encryption, the platters are readable. | No |
| Recycle Bin, temp copies, editor swap/backup files | Deleted `private/` records may linger unencrypted. | No |

### Portability makes this sharper

AxiomCE is designed to be **portable** — the whole point is to move the store
between machines and reassemble context elsewhere. Every copy, sync, and backup
of a portable store is another at-rest copy of `private/`. Confidentiality must
travel **with** the data, not depend on where it happens to sit today.

### Current posture (verify per deployment)

- **Store location — confirmed (2026-07-18):** the working stores live at
  drive-root paths, **not** under a cloud-synced profile directory, so
  `private/` is **not currently being synced**. This is the primary (free,
  already-true) mitigation and must be **preserved** — do not relocate the store
  under a synced/backed-up profile path.
- **Full-disk encryption — unresolved:** BitLocker/volume-encryption status was
  not readable without elevation. **Action:** verify `manage-bde -status` (or
  `Get-BitLockerVolume`) shows the store's volume fully encrypted with an active
  protector.
- **Filesystem ACLs — unresolved:** whether `private/` is owner-only vs.
  inherited `Users`-readable was not audited. **Action:** restrict `private/` to
  the owner account.

### Recommended mitigations (tiered, lowest effort first)

1. **Keep the store off any synced/backed-up path** (free; already true).
   Never place it under OneDrive/Dropbox/iCloud or a corporate-synced profile.
2. **Full-disk encryption** (BitLocker on Windows, FileVault, LUKS). Defeats
   disk theft/loss and decommissioning. Verify it is actually *on*.
3. **Owner-only ACLs on `private/`** so other local accounts cannot read it
   (Windows: remove inherited `Users`, grant only the owner; POSIX: `chmod 700`).
4. **Encrypt the partition itself at rest** for defense-in-depth and portable
   backups — an encrypted container (VeraCrypt), per-folder encryption (EFS/age),
   or an `age`/`gpg`-encrypted archive that travels with the store. This is the
   piece that makes `private/` safe to *move* and to *back up*.
5. **Backup hygiene:** encrypt backups, or exclude `private/` from any cloud
   backup, or encrypt it before upload. An unencrypted backup silently undoes 1–4.
6. **Never-store class stays entirely out** (passwords, keys, tokens, SSNs, full
   account/card numbers): those belong in a password manager/vault, **never** in
   `private/` even encrypted (`PRIVATE_DATA.md`). Encryption of `private/` raises
   the bar for Restricted data; it does not license storing Never-store secrets.

### Scope boundary

Encrypting `private/` at rest is an **operator/OS responsibility**, not
something the runner can enforce from inside a zero-dependency Markdown engine —
the runner cannot guarantee the filesystem, backup policy, or sync client
underneath it. The engine's job is to (a) route sensitive content into
`private/` fail-closed, and (b) **document this boundary** so the operator
applies the at-rest controls their environment needs. This section is that
documentation; it is deliberately guidance, not a code mechanism.

## What was hardened this pass

- **H1** — faithful contradiction rendering in the projection (Axiom 11), with a
  regression test.
- **H9** — data-at-rest confidentiality boundary for `private/` documented
  (git-exclusion ≠ encryption): exposure vectors, current posture, and tiered
  operator mitigations. Guidance, not a code mechanism (see §Data-at-rest
  confidentiality).
- This register created as the standing home for the remaining items.
