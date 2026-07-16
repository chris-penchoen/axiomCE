---
title: MANIFEST.json Removal Decision
type: decision
classification: public
created: 2026-07-16
updated: 2026-07-16
---

# Why MANIFEST.json Was Removed

**Date:** 2026-07-16  
**Reason:** Stale authority is worse than no authority.

## The Problem

The previous `MANIFEST.json` listed:
- Files that no longer exist (`SOCIAL_POST.md`)
- Incomplete surface area (omitted governance, schemas, templates, tooling)
- No automated validation

AxiomCE emphasizes explicit authority and reconciliation. A hand-maintained manifest that drifts from reality violates that principle.

## The Solution

Removed `MANIFEST.json` entirely.

**Discovery mechanisms remain clear:**
- `git ls-files` shows all tracked content
- Directory structure is self-documenting (see repo root)
- `README.md` links to key entry points
- Front matter on each file declares its type and classification

## If a Manifest Is Needed Later

Should the project need a canonical file list again, it should be:
- **Generated at build time** by scanning the directory and front matter
- **Validated in CI** against actual files (fail if it drifts)
- **Read-only** in version control (so it never accidentally becomes the source of truth)

A stale manifest that nobody validates is worse than none.

## References

- [CURRENT_STATUS.md](CURRENT_STATUS.md) — framework capability vs. evidence
- [CONVENTIONS.md](CONVENTIONS.md) — front-matter standards
- [SOURCE_POLICY.md](SOURCE_POLICY.md) — authority and reconciliation principles
