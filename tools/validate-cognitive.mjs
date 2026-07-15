#!/usr/bin/env node
// AxiomCE — validate-cognitive.mjs
//
// Structural validator for the cognitive-model pillar. Complements validate.mjs
// (generic Markdown front matter + links) with checks specific to policy rule
// IDs and calibration references. Zero external dependencies.
//
// Checks:
//   - policy rule IDs are well-formed  (CM-<NS>-NN, NS in the allowed set)
//   - a heading that looks like an ID but is malformed is reported
//   - policy rule IDs are unique across all policy files
//   - every calibration case cites at least one rule and all cited rule IDs
//     exist in the policy layer
//   - calibration case ids are unique and match their filename
//
// It does NOT re-check generic front matter (validate.mjs owns that) and does
// NOT do any semantic / model-based evaluation.
//
// Usage:
//   node tools/validate-cognitive.mjs           # validate the pillar
//   node tools/validate-cognitive.mjs <root>    # validate under a specific root

import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter } from "./validate.mjs";

export const CM_NAMESPACES = ["OPT", "DECISION", "FRICTION", "DELIVERY", "INTERACTION"];
// e.g. CM-DELIVERY-01, CM-OPT-AG-01
export const CM_ID_RE = /^CM-[A-Z]+(?:-[A-Z]+)*-\d{2,}$/;

const POLICY_DIR = path.join("cognitive-model", "policy");
const CASES_DIR = path.join("cognitive-model", "calibration", "cases");

/** The namespace of a rule id is the token immediately after `CM-`. */
export function namespaceOf(id) {
  const m = /^CM-([A-Z]+)/.exec(id);
  return m ? m[1] : null;
}

/**
 * Extract policy rule IDs from a policy file's headings.
 * A heading whose text starts with a `CM-` token is a candidate; candidates that
 * do not match CM_ID_RE (or use an unknown namespace) are reported as malformed.
 * @param {string} content
 * @returns {{ ids: string[], malformed: string[] }}
 */
export function extractPolicyIds(content) {
  const ids = [];
  const malformed = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^#{2,4}\s+(CM-\S+)/.exec(line);
    if (!h) continue;
    const token = h[1].replace(/[.,;:]+$/, "");
    if (CM_ID_RE.test(token) && CM_NAMESPACES.includes(namespaceOf(token))) {
      ids.push(token);
    } else {
      malformed.push(token);
    }
  }
  return { ids, malformed };
}

/** Extract cited rule IDs from a `rules:` front-matter value string. */
export function extractRuleRefs(rulesValue) {
  if (!rulesValue) return [];
  const out = [];
  const re = /CM-[A-Z]+(?:-[A-Z]+)*-\d{2,}/g;
  let m;
  while ((m = re.exec(rulesValue)) !== null) out.push(m[0]);
  return out;
}

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name);
}

/**
 * Validate the cognitive-model pillar under `root`.
 * @param {string} root
 * @returns {{ policyCount: number, caseCount: number, problems: Array<{file:string, msg:string}> }}
 */
export function validateCognitive(root) {
  const problems = [];
  const policyAbs = path.join(root, POLICY_DIR);
  const casesAbs = path.join(root, CASES_DIR);

  // --- policy layer: collect and de-duplicate rule ids ---
  const idHome = new Map(); // id -> first file that defined it
  let policyCount = 0;
  for (const name of listMarkdown(policyAbs)) {
    const rel = path.join(POLICY_DIR, name);
    const content = fs.readFileSync(path.join(policyAbs, name), "utf8");
    const { ids, malformed } = extractPolicyIds(content);
    for (const bad of malformed) {
      problems.push({ file: rel, msg: `malformed policy id in heading: "${bad}"` });
    }
    for (const id of ids) {
      policyCount++;
      if (idHome.has(id)) {
        problems.push({ file: rel, msg: `duplicate policy id: ${id} (already defined in ${idHome.get(id)})` });
      } else {
        idHome.set(id, rel);
      }
    }
  }
  const knownIds = new Set(idHome.keys());

  // --- calibration layer: unique ids + valid references ---
  const seenCaseIds = new Map(); // case_id -> file
  const cases = listMarkdown(casesAbs);
  for (const name of cases) {
    const rel = path.join(CASES_DIR, name);
    const content = fs.readFileSync(path.join(casesAbs, name), "utf8");
    const fm = parseFrontMatter(content).data;

    const caseId = fm.case_id;
    const base = name.replace(/\.md$/i, "");
    if (!caseId) {
      problems.push({ file: rel, msg: "calibration case missing case_id" });
    } else {
      if (caseId !== base) {
        problems.push({ file: rel, msg: `case_id "${caseId}" does not match filename "${base}"` });
      }
      if (seenCaseIds.has(caseId)) {
        problems.push({ file: rel, msg: `duplicate case_id: ${caseId} (also in ${seenCaseIds.get(caseId)})` });
      } else {
        seenCaseIds.set(caseId, rel);
      }
    }

    const refs = extractRuleRefs(fm.rules);
    if (refs.length === 0) {
      problems.push({ file: rel, msg: "calibration case cites no policy rules (empty or missing `rules:`)" });
    }
    for (const ref of refs) {
      if (!knownIds.has(ref)) {
        problems.push({ file: rel, msg: `calibration cites missing policy id: ${ref}` });
      }
    }
  }

  return { policyCount, caseCount: cases.length, problems };
}

// --- CLI ---
const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const root = path.resolve(process.argv[2] || ".");
  const { policyCount, caseCount, problems } = validateCognitive(root);
  for (const p of problems) console.error(`FAIL ${p.file}: ${p.msg}`);
  if (problems.length) {
    console.error(`\nvalidate-cognitive: ${problems.length} problem(s) across ${policyCount} rule(s), ${caseCount} case(s).`);
    process.exit(1);
  }
  console.log(`validate-cognitive: OK — ${policyCount} policy rule(s), ${caseCount} calibration case(s), no problems.`);
  process.exit(0);
}
