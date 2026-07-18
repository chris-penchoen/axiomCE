#!/usr/bin/env node
// AxiomCE — validate-claims.mjs
//
// Structural validator for the hybrid layer: append-only claim logs (.jsonl),
// entity references, and the kernel ontology (.yaml). Complements validate.mjs
// (Markdown) and privacy-check.mjs (leak scanning). Zero external dependencies.
//
// Validates the WHOLE store (tracked + private) structurally — private claims
// are authoritative local context and must be internally consistent. It does
// NOT judge whether restricted data is placed correctly; that is privacy-check's
// job (which, correctly, never treats git-ignored private files as leaks).
//
// Checks:
//   - every .jsonl line parses as JSON (malformed line => fail, with line no.)
//   - each claim has required fields, correct types, valid enums, ISO dates/
//     timestamps, a well-formed id, a kebab-case predicate
//   - no unknown fields
//   - claim ids are unique across the whole store
//   - `entity` references an existing entity_id
//   - `supersedes` references an existing claim id (and is not self)
//   - tracked .yaml files are well-formed; kernel/ontology.yaml has required keys
//
// Usage:
//   node tools/validate-claims.mjs           # validate the store
//   node tools/validate-claims.mjs <root>    # validate a specific root

import fs from "node:fs";
import path from "node:path";
import { ALLOWED_CLASSIFICATIONS } from "./validate.mjs";
import { loadEntities } from "./generate-views.mjs";

export const CONFIDENCE_LEVELS = [
  "confirmed",
  "user-stated",
  "inferred",
  "estimate",
  "unresolved",
];

export const CLAIM_REQUIRED = [
  "id", "entity", "predicate", "value", "confidence",
  "classification", "valid_from", "asserted_at", "source",
];
export const CLAIM_OPTIONAL = ["valid_to", "retracted_at", "retraction_reason", "supersedes", "note"];
const CLAIM_ALLOWED = new Set([...CLAIM_REQUIRED, ...CLAIM_OPTIONAL]);

const CLAIM_DIRS = ["claims", path.join("private", "claims")];

const ID_RE = /^clm-[a-z0-9]+-\d{4,}$/;
const ENTITY_RE = /^[a-z]+:[a-z0-9][a-z0-9-]*$/;
const PRED_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Validate a single claim object's shape (no cross-file checks).
 * @param {object} c
 * @returns {string[]} problems
 */
export function validateClaimShape(c) {
  const p = [];
  if (typeof c !== "object" || c === null || Array.isArray(c)) {
    return ["claim is not a JSON object"];
  }
  for (const k of CLAIM_REQUIRED) {
    if (!(k in c) || c[k] === null || c[k] === undefined || c[k] === "") {
      p.push(`missing required field: ${k}`);
    }
  }
  for (const k of Object.keys(c)) {
    if (!CLAIM_ALLOWED.has(k)) p.push(`unknown field: ${k}`);
  }

  if (c.id !== undefined && c.id !== null && !ID_RE.test(String(c.id))) {
    p.push(`invalid id format: "${c.id}" (expected clm-<domain>-NNNN)`);
  }
  if (c.entity !== undefined && c.entity !== null && !ENTITY_RE.test(String(c.entity))) {
    p.push(`invalid entity id: "${c.entity}" (expected <type>:<slug>)`);
  }
  if (c.predicate !== undefined && c.predicate !== null && !PRED_RE.test(String(c.predicate))) {
    p.push(`invalid predicate (must be kebab-case): "${c.predicate}"`);
  }
  if (c.value !== undefined && typeof c.value !== "string") {
    p.push("value must be a string");
  }
  if (c.source !== undefined && typeof c.source !== "string") {
    p.push("source must be a string");
  }
  if (c.confidence !== undefined && !CONFIDENCE_LEVELS.includes(c.confidence)) {
    p.push(`invalid confidence "${c.confidence}" (allowed: ${CONFIDENCE_LEVELS.join(", ")})`);
  }
  if (c.classification !== undefined && !ALLOWED_CLASSIFICATIONS.includes(c.classification)) {
    p.push(`invalid classification "${c.classification}" (allowed: ${ALLOWED_CLASSIFICATIONS.join(", ")})`);
  }
  if (c.valid_from !== undefined && c.valid_from !== null && !DATE_RE.test(String(c.valid_from))) {
    p.push(`invalid valid_from "${c.valid_from}" (expected YYYY-MM-DD)`);
  }
  if (c.valid_to !== undefined && c.valid_to !== null && !DATE_RE.test(String(c.valid_to))) {
    p.push(`invalid valid_to "${c.valid_to}" (expected YYYY-MM-DD or null)`);
  }
  if (c.valid_from && c.valid_to && DATE_RE.test(c.valid_from) && DATE_RE.test(c.valid_to) &&
      c.valid_to < c.valid_from) {
    p.push(`valid_to (${c.valid_to}) is before valid_from (${c.valid_from})`);
  }
  if (c.asserted_at !== undefined && c.asserted_at !== null && !DATETIME_RE.test(String(c.asserted_at))) {
    p.push(`invalid asserted_at "${c.asserted_at}" (expected ISO timestamp)`);
  }
  if (c.retracted_at !== undefined && c.retracted_at !== null && !DATETIME_RE.test(String(c.retracted_at))) {
    p.push(`invalid retracted_at "${c.retracted_at}" (expected ISO timestamp or null)`);
  }
  if (c.supersedes !== undefined && c.supersedes !== null) {
    if (!ID_RE.test(String(c.supersedes))) {
      p.push(`invalid supersedes id: "${c.supersedes}"`);
    } else if (c.supersedes === c.id) {
      p.push(`claim supersedes itself: ${c.id}`);
    }
  }
  // retraction_reason: optional free text, but if present must be a non-empty
  // string and only meaningful alongside retracted_at (an audited tombstone).
  if (c.retraction_reason !== undefined && c.retraction_reason !== null) {
    if (typeof c.retraction_reason !== "string" || c.retraction_reason.trim() === "") {
      p.push("retraction_reason must be a non-empty string when present");
    } else if (!c.retracted_at) {
      p.push("retraction_reason set without retracted_at (a reason must accompany a retraction)");
    }
  }
  return p;
}

/** Tolerantly load claim lines (records malformed lines rather than throwing). */
export function loadClaimLines(root) {
  const records = []; // { obj, file, line }
  const malformed = []; // { file, line, msg }
  for (const dir of CLAIM_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.toLowerCase().endsWith(".jsonl")) continue;
      const rel = path.join(dir, name);
      const text = fs.readFileSync(path.join(abs, name), "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (!t) return;
        try {
          records.push({ obj: JSON.parse(t), file: rel, line: i + 1 });
        } catch (e) {
          malformed.push({ file: rel, line: i + 1, msg: `malformed JSON: ${e.message}` });
        }
      });
    }
  }
  return { records, malformed };
}

/** Light structural check for a YAML file (no YAML library). */
export function validateYamlFile(filePath) {
  const problems = [];
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.trim()) return ["empty YAML file"];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes("\t")) problems.push(`line ${i + 1}: tab character (YAML forbids tabs)`);
    const t = line.replace(/\s+$/, "");
    if (!t.trim() || t.trim().startsWith("#")) return;
    const body = t.replace(/^\s+/, "");
    const ok =
      /^-\s?.*/.test(body) || // list item
      /^[\w.$-]+:\s*.*$/.test(body); // key: value / key:
    if (!ok) problems.push(`line ${i + 1}: not a comment, key, or list item: "${t.trim()}"`);
  });
  if (path.basename(filePath) === "ontology.yaml") {
    const topKeys = lines
      .filter((l) => /^[\w.$-]+:/.test(l))
      .map((l) => l.slice(0, l.indexOf(":")));
    for (const req of ["version", "claim", "confidence", "privacy", "layers"]) {
      if (!topKeys.includes(req)) problems.push(`ontology.yaml missing required top-level key: ${req}`);
    }
  }
  return problems;
}

/** Collect tracked + private .yaml files (skips node_modules/.git). */
export function collectYaml(root) {
  const out = [];
  const skip = new Set([".git", "node_modules"]);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (/\.ya?ml$/i.test(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Validate the whole store. Returns aggregated problems.
 * @param {string} root
 * @returns {{ claimCount: number, problems: Array<{file:string, line?:number, msg:string}> }}
 */
export function validateStore(root) {
  const problems = [];
  const { records, malformed } = loadClaimLines(root);
  for (const m of malformed) problems.push(m);

  const entityIds = new Set(loadEntities(root).map((e) => e.id));
  const idCounts = new Map();
  const knownIds = new Set();
  for (const { obj } of records) {
    if (obj && typeof obj === "object" && typeof obj.id === "string") {
      idCounts.set(obj.id, (idCounts.get(obj.id) || 0) + 1);
      knownIds.add(obj.id);
    }
  }

  for (const { obj, file, line } of records) {
    for (const msg of validateClaimShape(obj)) problems.push({ file, line, msg });
    if (obj && typeof obj === "object") {
      if (typeof obj.entity === "string" && !entityIds.has(obj.entity)) {
        problems.push({ file, line, msg: `references missing entity: ${obj.entity}` });
      }
      if (typeof obj.supersedes === "string" && !knownIds.has(obj.supersedes)) {
        problems.push({ file, line, msg: `supersedes missing claim: ${obj.supersedes}` });
      }
    }
  }
  for (const [id, n] of idCounts) {
    if (n > 1) problems.push({ file: "(store)", msg: `duplicate claim id: ${id} (${n} occurrences)` });
  }

  for (const y of collectYaml(root)) {
    const rel = path.relative(root, y);
    if (rel.split(/[\\/]/).includes("node_modules")) continue;
    for (const msg of validateYamlFile(y)) problems.push({ file: rel, msg });
  }

  return { claimCount: records.length, problems };
}

// --- CLI ---
const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const root = path.resolve(process.argv[2] || ".");
  const { claimCount, problems } = validateStore(root);
  for (const p of problems) {
    const loc = p.line ? `${p.file}:${p.line}` : p.file;
    console.error(`FAIL ${loc}: ${p.msg}`);
  }
  if (problems.length) {
    console.error(`\nvalidate-claims: ${problems.length} problem(s) across ${claimCount} claim(s).`);
    process.exit(1);
  }
  console.log(`validate-claims: OK — ${claimCount} claim(s), no structural problems.`);
  process.exit(0);
}
