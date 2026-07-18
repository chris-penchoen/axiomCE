#!/usr/bin/env node
// AxiomCE — generate-views.mjs
//
// Regenerates the DO-NOT-EDIT `*.view.md` projections from append-only claim
// logs (`*.jsonl`) plus entity front matter. Zero external dependencies: plain
// file I/O, JSON.parse, and the front-matter parser already shipped in
// validate.mjs. No database, embeddings, graph engine, service, or network.
//
// Precedence and rules live in kernel/BOOT.md and kernel/ontology.yaml.
//
// Usage:
//   node tools/generate-views.mjs            # regenerate all views
//   node tools/generate-views.mjs --check    # fail (exit 1) if any view is stale
//
// A restricted/sensitive entity's view is written to private/views/ (git-
// excluded); public/personal views go to tracked views/.

import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter } from "./validate.mjs";

const ROOT = path.resolve(".");
const TODAY = new Date().toISOString().slice(0, 10);

const ENTITY_DIRS = ["entities", path.join("private", "entities")];
const CLAIM_DIRS = ["claims", path.join("private", "claims")];
const PRIVATE_CLASSES = new Set(["restricted", "sensitive"]);

/** Read every *.jsonl claim across the claim dirs into one array. */
export function loadClaims(root = ROOT) {
  const claims = [];
  for (const dir of CLAIM_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.toLowerCase().endsWith(".jsonl")) continue;
      const text = fs.readFileSync(path.join(abs, name), "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (!t) return;
        try {
          claims.push(JSON.parse(t));
        } catch (e) {
          throw new Error(`Invalid JSON in ${dir}/${name} line ${i + 1}: ${e.message}`);
        }
      });
    }
  }
  return claims;
}

/** Read entity front matter into { id, title, classification, canonical, file }. */
export function loadEntities(root = ROOT) {
  const entities = [];
  for (const dir of ENTITY_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      const file = path.join(abs, name);
      const { data } = parseFrontMatter(fs.readFileSync(file, "utf8"));
      if (!data.entity_id) continue;
      entities.push({
        id: data.entity_id,
        title: data.title || data.entity_id,
        classification: data.classification || "personal",
        canonical: data.canonical || null,
        claims: data.claims || null,
        file,
      });
    }
  }
  return entities;
}

/**
 * Classify each claim's lifecycle state relative to `today`.
 * @returns {{ active: object[], history: object[], contradictions: Map<string, object[]> }}
 */
export function classify(claims, today = TODAY) {
  const supersededIds = new Set(claims.filter((c) => c.supersedes).map((c) => c.supersedes));
  const isExpired = (c) => c.valid_to && c.valid_to < today;
  const isActive = (c) =>
    !c.retracted_at && !supersededIds.has(c.id) && !isExpired(c);

  const active = claims.filter(isActive);
  const history = claims.filter((c) => !isActive(c));

  const byPredicate = new Map();
  for (const c of active) {
    if (!byPredicate.has(c.predicate)) byPredicate.set(c.predicate, []);
    byPredicate.get(c.predicate).push(c);
  }
  const contradictions = new Map();
  for (const [pred, list] of byPredicate) {
    if (list.length > 1) contradictions.set(pred, list);
  }
  return { active, history, contradictions, supersededIds, isExpired };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Evidence weight for a claim within a set sharing a predicate: the number of
 * DISTINCT sources asserting the same value. Axiom 10 — evidence (corroboration
 * by independent provenance, Axiom 9) outranks a confidence label. Provenance
 * *tier/quality* is not modeled in the claim schema yet, so distinct-source
 * COUNT is the ratified proxy (ratification_log: ax10-evidence-resolution).
 * Value comparison is whitespace-normalized but case-sensitive — different
 * phrasings are deliberately NOT merged (conservative: do not over-corroborate).
 */
export function evidenceWeight(claim, list) {
  const norm = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
  const target = norm(claim.value);
  const sources = new Set(
    list.filter((c) => norm(c.value) === target).map((c) => c.source)
  );
  return sources.size;
}

// Governance precedence for resolving which claim *governs* a contradicted
// predicate in a view — used ONLY as the tiebreaker under evidence weight
// (Axiom 10). An explicit `unresolved` safety guard OUTRANKS an optimistic
// `estimate` (safety-first: "unknown" must not be overridden by a guess).
export const GOVERNANCE_PRECEDENCE = [
  "confirmed",
  "user-stated",
  "inferred",
  "unresolved",
  "estimate",
];

/**
 * Pick the governing claim from a set sharing a predicate. Axiom 10: rank by
 * evidence weight (distinct-source corroboration of the value) FIRST; break ties
 * by confidence precedence (safety nuance: unresolved outranks estimate), then
 * by lowest id. A lone confident-but-weakly-sourced claim does not outrank a
 * lower-confidence value corroborated by several independent sources —
 * disconfirming evidence cuts hardest because the opposing value simply carries
 * more independent weight.
 */
export function governing(list) {
  return list.slice().sort((a, b) => {
    const wa = evidenceWeight(a, list);
    const wb = evidenceWeight(b, list);
    if (wa !== wb) return wb - wa; // higher evidence weight governs
    const pa = GOVERNANCE_PRECEDENCE.indexOf(a.confidence);
    const pb = GOVERNANCE_PRECEDENCE.indexOf(b.confidence);
    const na = pa === -1 ? GOVERNANCE_PRECEDENCE.length : pa;
    const nb = pb === -1 ? GOVERNANCE_PRECEDENCE.length : pb;
    if (na !== nb) return na - nb;
    return byId(a, b);
  })[0];
}

/** Render the Markdown view body for one entity. */
export function renderView(entity, claims, today = TODAY) {
  const mine = claims.filter((c) => c.entity === entity.id).sort(byId);
  const { active, history, contradictions, supersededIds, isExpired } = classify(mine, today);
  const contradicted = new Set([...contradictions.keys()]);

  const lines = [];
  lines.push("---");
  lines.push(`title: ${entity.title} — generated view`);
  lines.push("type: view");
  lines.push(`classification: ${entity.classification}`);
  lines.push("generated: true");
  lines.push(`updated: ${today}`);
  lines.push("source: tools/generate-views.mjs");
  lines.push("---");
  lines.push("");
  lines.push(`<!-- DO NOT EDIT. Generated by tools/generate-views.mjs from`);
  lines.push(`     ${entity.claims || "the claim log"}. Edit claims, then regenerate. -->`);
  lines.push("");
  lines.push(`# ${entity.title} — view`);
  lines.push("");
  lines.push(`- **Entity:** \`${entity.id}\``);
  if (entity.canonical) lines.push(`- **Canonical record:** \`${entity.canonical}\``);
  if (entity.claims) lines.push(`- **Claim log:** \`${entity.claims}\``);
  lines.push(`- **Generated:** ${today} · **Active facts:** ${active.length} · ` +
    `**Contradictions:** ${contradictions.size} · **History entries:** ${history.length}`);
  lines.push("");

  // Contradictions first — highest signal.
  lines.push("## Contradictions");
  lines.push("");
  if (contradictions.size === 0) {
    lines.push("_None. No predicate has more than one active claim._");
  } else {
    lines.push("> Multiple active claims share a predicate. Resolve by appending a");
    lines.push("> superseding claim or retracting one — do not edit history.");
    lines.push("");
    for (const [pred, list] of [...contradictions].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const gov = governing(list);
      const govW = evidenceWeight(gov, list);
      lines.push(`- **\`${pred}\`** — ${list.length} active (governing: \`${gov.id}\`, ${gov.confidence}, ` +
        `evidence: ${govW} source${govW === 1 ? "" : "s"}):`);
      for (const c of list.sort(byId)) {
        const mark = c.id === gov.id ? " ← governs" : "";
        const w = evidenceWeight(c, list);
        lines.push(`  - \`${c.id}\` (${c.confidence}; ${w} src): ${c.value}${mark}` + (c.note ? ` — ${c.note}` : ""));
      }
    }
  }
  lines.push("");

  // Active facts by predicate.
  lines.push("## Active facts");
  lines.push("");
  if (active.length === 0) {
    lines.push("_No active claims._");
  } else {
    for (const c of active.slice().sort((a, b) =>
      a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : byId(a, b))) {
      const flag = contradicted.has(c.predicate) ? " ⚠" : "";
      const vt = c.valid_to ? `, valid to ${c.valid_to}` : "";
      lines.push(`- **\`${c.predicate}\`**${flag}: ${c.value}  ` +
        `\n  _(${c.confidence}; ${c.id}; from ${c.valid_from}${vt}; source: ${c.source})_` +
        (c.note ? `\n  ${c.note}` : ""));
    }
  }
  lines.push("");

  // History: superseded / retracted / expired.
  lines.push("## History (superseded · retracted · expired)");
  lines.push("");
  if (history.length === 0) {
    lines.push("_None._");
  } else {
    for (const c of history.slice().sort(byId)) {
      let state = "superseded";
      if (c.retracted_at) state = "retracted";
      else if (isExpired(c)) state = "expired";
      else if (supersededIds.has(c.id)) state = "superseded";
      lines.push(`- \`${c.id}\` **[${state}]** \`${c.predicate}\`: ${c.value}` +
        (c.note ? ` — ${c.note}` : ""));
    }
  }
  lines.push("");

  // Open questions: active + unresolved.
  const open = active.filter((c) => c.confidence === "unresolved").sort(byId);
  lines.push("## Open questions (active + unresolved)");
  lines.push("");
  if (open.length === 0) lines.push("_None._");
  else for (const c of open) lines.push(`- \`${c.predicate}\`: ${c.value} (\`${c.id}\`)`);
  lines.push("");

  return lines.join("\n") + "\n";
}

/** Compute the output path for an entity's view. */
export function viewPath(entity, root = ROOT) {
  const slug = entity.id.replace(/:/g, "-");
  const dir = PRIVATE_CLASSES.has(entity.classification)
    ? path.join(root, "private", "views")
    : path.join(root, "views");
  return path.join(dir, `${slug}.view.md`);
}

export function generateAll(root = ROOT, { check = false } = {}) {
  const claims = loadClaims(root);
  const entities = loadEntities(root).sort((a, b) => (a.id < b.id ? -1 : 1));
  const results = [];
  for (const e of entities) {
    const out = viewPath(e, root);
    const body = renderView(e, claims);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
    const stale = existing !== body;
    if (!check && stale) fs.writeFileSync(out, body, "utf8");
    results.push({ entity: e.id, out: path.relative(root, out), stale });
  }
  return results;
}

// --- CLI ---
const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const check = process.argv.includes("--check");
  const results = generateAll(ROOT, { check });
  for (const r of results) {
    const tag = check ? (r.stale ? "STALE" : "ok") : (r.stale ? "written" : "unchanged");
    console.log(`${tag.padEnd(9)} ${r.entity} -> ${r.out}`);
  }
  if (check && results.some((r) => r.stale)) {
    console.error("\ngenerate-views --check: views are stale. Run: node tools/generate-views.mjs");
    process.exit(1);
  }
  console.log(`\ngenerate-views: ${results.length} view(s) ${check ? "checked" : "generated"}.`);
  process.exit(0);
}
