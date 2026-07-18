#!/usr/bin/env node
// AxiomCE — reconcile.mjs
//
// Detects divergence between canonical prose and the active structured claims,
// without any fuzzy/semantic comparison. Reconciliation is driven by an EXPLICIT
// manifest (reconcile/manifest.jsonl + private/reconcile/manifest.jsonl) that
// declares which canonical fields are claim-backed. Zero dependencies.
//
// Each manifest line: { entity, predicate, canonical, token }
//   - entity/predicate identify the claim-backed field
//   - canonical is the prose file that should reflect it
//   - token is the literal string expected to appear in `canonical` when in sync
//
// Findings (this tool NEVER rewrites canonical prose):
//   MISSING_CLAIM           manifest field has no active claim
//   STALE_CANONICAL         canonical prose does not contain the expected token
//   UNRESOLVED_CONTRADICTION  >1 active claim for the field (live — needs a human)
//   DORMANT_CONTRADICTION   >1 active claim, but parked per Axiom 12 (info only,
//                           non-blocking; reactivates on new evidence)
//   STALE_VIEW              a generated *.view.md is out of date
//
// Usage:
//   node tools/reconcile.mjs            # report; exit 1 if any finding
//   node tools/reconcile.mjs <root>

import fs from "node:fs";
import path from "node:path";
import { loadClaims, classify, generateAll } from "./generate-views.mjs";

const MANIFEST_FILES = [
  "reconcile/manifest.jsonl",
  path.join("private", "reconcile", "manifest.jsonl"),
];

/** Load manifest entries from tracked + private manifests. */
export function loadManifest(root) {
  const entries = [];
  for (const rel of MANIFEST_FILES) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    fs.readFileSync(abs, "utf8").split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try {
        const e = JSON.parse(t);
        if (e.entity && e.predicate && e.canonical && e.token) {
          entries.push({ ...e, __file: rel, __line: i + 1 });
        } else {
          entries.push({ __file: rel, __line: i + 1, __malformed: "missing entity/predicate/canonical/token" });
        }
      } catch (err) {
        entries.push({ __file: rel, __line: i + 1, __malformed: `bad JSON: ${err.message}` });
      }
    });
  }
  return entries;
}

/**
 * Reconcile the store. Returns a list of findings.
 * @param {string} root
 * @returns {Array<{type:string, entity?:string, predicate?:string, detail:string}>}
 */
export function reconcile(root, today) {
  const findings = [];
  const claims = loadClaims(root);
  const manifest = loadManifest(root);

  // Stale views (regeneration would change output).
  for (const r of generateAll(root, { check: true })) {
    if (r.stale) findings.push({ type: "STALE_VIEW", entity: r.entity, detail: `view out of date: ${r.out}` });
  }

  for (const m of manifest) {
    if (m.__malformed) {
      findings.push({ type: "MANIFEST_ERROR", detail: `${m.__file}:${m.__line} ${m.__malformed}` });
      continue;
    }
    const mine = claims.filter((c) => c.entity === m.entity);
    const { active, dormant } = classify(mine, today);
    const act = active.filter((c) => c.predicate === m.predicate);
    if (act.length === 0) {
      findings.push({ type: "MISSING_CLAIM", entity: m.entity, predicate: m.predicate,
        detail: `no active claim for ${m.entity} ${m.predicate}` });
      continue;
    }
    if (act.length > 1) {
      // Axiom 12: a dormant (parked) contradiction is reported as informational,
      // NOT as an open UNRESOLVED_CONTRADICTION to be acted on — it sat past the
      // dormancy threshold with no new evidence and is intentionally parked
      // (still preserved; reactivates on a newer claim).
      const type = dormant.has(m.predicate) ? "DORMANT_CONTRADICTION" : "UNRESOLVED_CONTRADICTION";
      findings.push({ type, entity: m.entity, predicate: m.predicate,
        detail: `${act.length} active claims for ${m.entity} ${m.predicate}` });
      continue;
    }
    const canonAbs = path.join(root, m.canonical);
    if (!fs.existsSync(canonAbs)) {
      findings.push({ type: "STALE_CANONICAL", entity: m.entity, predicate: m.predicate,
        detail: `canonical file missing: ${m.canonical}` });
      continue;
    }
    const canonText = fs.readFileSync(canonAbs, "utf8");
    if (!canonText.includes(m.token)) {
      findings.push({ type: "STALE_CANONICAL", entity: m.entity, predicate: m.predicate,
        detail: `canonical ${m.canonical} missing token "${m.token}" for active claim ${act[0].id}` });
    }
  }
  return findings;
}

// --- CLI ---
const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const root = path.resolve(process.argv[2] || ".");
  const findings = reconcile(root);
  const INFO_ONLY = new Set(["DORMANT_CONTRADICTION"]);
  for (const f of findings) console.error(`${f.type.padEnd(24)} ${f.detail}`);
  const blocking = findings.filter((f) => !INFO_ONLY.has(f.type));
  if (blocking.length) {
    console.error(`\nreconcile: ${blocking.length} finding(s). Canonical prose left untouched — resolve manually.`);
    process.exit(1);
  }
  const info = findings.length - blocking.length;
  console.log(`reconcile: OK — canonical prose, claims, and views are in sync.` +
    (info ? ` (${info} informational: dormant/parked — no action needed.)` : ""));
  process.exit(0);
}
