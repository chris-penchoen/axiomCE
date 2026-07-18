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

// Axiom 12 — dormancy. A contradiction that has stayed visibly unresolved with
// NO new evidence for this many days is auto-PARKED (moved off the active
// "needs-you" surface into a still-visible `dormant` bucket). Parking is NOT
// resolution: both sides are preserved and it reactivates automatically the
// moment a newer claim touches the predicate. This is the single human-set
// policy knob (ratification_log: ax12-dormancy). The ratified spec also names
// an "OR N sync cycles" trigger; that requires a persistent runtime cycle
// counter which does not exist yet, so the portable engine parks on elapsed
// time only — a strict subset that never parks *earlier* than the cycle rule
// would. The cycle trigger is a deferred runtime complement.
export const DEFAULT_DORMANCY_DAYS = 90;

const ENTITY_DIRS = ["entities", path.join("private", "entities")];
const CLAIM_DIRS = ["claims", path.join("private", "claims")];
// Fail-closed: an entity's views are PUBLIC only for explicit public classes
// (public/personal); restricted/sensitive AND missing/unknown route to private/.
const PUBLIC_CLASSES = new Set(["public", "personal"]);

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
 * Days since the most recent evidence (asserted_at, falling back to valid_from)
 * touched any claim in a contradicted set. This is "how long the contradiction
 * has sat with no new evidence" — a newer claim on the predicate lowers this to
 * ~0, which is exactly how Axiom 12 auto-reactivation is expressed: no separate
 * un-park step is needed.
 */
export function contradictionAgeDays(list, today = TODAY) {
  const latest = list
    .map((c) => String(c.asserted_at || c.valid_from || "").slice(0, 10))
    .filter(Boolean)
    .sort()
    .pop();
  if (!latest) return 0;
  const ms = Date.parse(today + "T00:00:00Z") - Date.parse(latest + "T00:00:00Z");
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : 0;
}

/** Axiom 12: a contradiction is dormant once it exceeds the (human-set) day threshold with no new evidence. */
export function isDormant(list, today = TODAY, dormancyDays = DEFAULT_DORMANCY_DAYS) {
  return contradictionAgeDays(list, today) >= dormancyDays;
}

/** Whitespace-normalized, case-sensitive value key. Different phrasings are
 * deliberately NOT merged (conservative: never over-corroborate or falsely
 * reconcile a disagreement). Shared by distinctValues + evidenceWeight so the
 * corroboration and evidence-weight views agree on what "the same value" means. */
const normValue = (v) => String(v ?? "").trim().replace(/\s+/g, " ");

/** Count of DISTINCT normalized values asserted across a set sharing a predicate.
 * 1 => every active claim agrees (corroboration); >1 => genuine disagreement. */
export function distinctValues(list) {
  return new Set(list.map((c) => normValue(c.value))).size;
}

/**
 * Classify each claim's lifecycle state relative to `today`.
 * A predicate with >1 active claim is a genuine CONTRADICTION only when the
 * claims assert more than one distinct value. When several independent sources
 * assert the SAME value it is CORROBORATION (Axiom 9), not conflict — it is
 * surfaced as `corroborated` and never flagged or parked. Genuine contradictions
 * split into `contradictions` (LIVE — needs a human) and `dormant` (parked past
 * the dormancy threshold per Axiom 12 — still visible, never resolved/deleted).
 * @returns {{ active: object[], history: object[], contradictions: Map<string, object[]>, dormant: Map<string, object[]>, corroborated: Map<string, object[]> }}
 */
export function classify(claims, today = TODAY, opts = {}) {
  const dormancyDays = opts.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
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
  const dormant = new Map();
  const corroborated = new Map();
  for (const [pred, list] of byPredicate) {
    if (list.length > 1) {
      if (distinctValues(list) === 1) {
        corroborated.set(pred, list);            // independent sources agree — Axiom 9
      } else if (isDormant(list, today, dormancyDays)) {
        dormant.set(pred, list);
      } else {
        contradictions.set(pred, list);
      }
    }
  }
  return { active, history, contradictions, dormant, corroborated, supersededIds, isExpired };
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
  const target = normValue(claim.value);
  const sources = new Set(
    list.filter((c) => normValue(c.value) === target).map((c) => c.source)
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
  const { active, history, contradictions, dormant, corroborated, supersededIds, isExpired } = classify(mine, today);
  const contradicted = new Set([...contradictions.keys()]);
  const parked = new Set([...dormant.keys()]);
  const agreed = new Set([...corroborated.keys()]);

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
    `**Contradictions:** ${contradictions.size} · **Corroborated:** ${corroborated.size} · ` +
    `**Dormant:** ${dormant.size} · **History entries:** ${history.length}`);
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

  // Dormant contradictions — parked per Axiom 12: unresolved but sat past the
  // dormancy threshold with no new evidence. Kept visible (Axiom 11: no
  // concealment); reactivates automatically when a newer claim arrives.
  lines.push("## Dormant contradictions (parked — unresolved, no new evidence)");
  lines.push("");
  if (dormant.size === 0) {
    lines.push("_None._");
  } else {
    lines.push("> These stayed unresolved past the dormancy threshold with no new");
    lines.push("> evidence, so they were auto-parked off the active surface. This is");
    lines.push("> NOT resolution — both sides are preserved. A new claim on the");
    lines.push("> predicate reactivates it automatically.");
    lines.push("");
    for (const [pred, list] of [...dormant].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const gov = governing(list);
      const govW = evidenceWeight(gov, list);
      const age = contradictionAgeDays(list, today);
      lines.push(`- **\`${pred}\`** 💤 — ${list.length} active, ${age}d since last evidence ` +
        `(evidence-weighted default: \`${gov.id}\`, ${gov.confidence}, ${govW} source${govW === 1 ? "" : "s"}):`);
      for (const c of list.sort(byId)) {
        const w = evidenceWeight(c, list);
        lines.push(`  - \`${c.id}\` (${c.confidence}; ${w} src): ${c.value}` + (c.note ? ` — ${c.note}` : ""));
      }
    }
  }
  lines.push("");

  // Corroborated facts — >1 active claim on a predicate, all asserting the SAME
  // value from independent sources (Axiom 9). This is agreement, not conflict:
  // never flagged, never parked. Surfaced positively because independent
  // corroboration is the strongest evidence signal (Axiom 10).
  lines.push("## Corroborated facts (independent sources agree)");
  lines.push("");
  if (corroborated.size === 0) {
    lines.push("_None._");
  } else {
    for (const [pred, list] of [...corroborated].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const gov = governing(list);
      const w = evidenceWeight(gov, list);
      lines.push(`- **\`${pred}\`** ✓ — ${gov.value} _(corroborated by ${w} independent ` +
        `source${w === 1 ? "" : "s"}: ${[...new Set(list.map((c) => c.source))].sort().join(", ")})_`);
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
      const flag = contradicted.has(c.predicate) ? " ⚠" : parked.has(c.predicate) ? " 💤"
        : agreed.has(c.predicate) ? " ✓" : "";
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
  const dir = PUBLIC_CLASSES.has(entity.classification)
    ? path.join(root, "views")
    : path.join(root, "private", "views");
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
