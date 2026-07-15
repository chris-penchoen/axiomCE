#!/usr/bin/env node
// AxiomCE — runner.mjs
//
// The Continuity-Engine memory-transfer runner. A deterministic, model-agnostic
// harness that closes the continuity loop around a conversational AI:
//
//   project  (egress)  — assemble the smallest authoritative context package
//                        from the store (active claims + current context +
//                        optional collaboration policy) to hand a fresh model.
//   capture  (ingest)  — take an agent-normalized candidate-claims envelope
//                        (what a model extracted from a conversation), validate
//                        it structurally, privacy-gate it, route it to the right
//                        append-only claim log, and mint stable ids.
//
// The runner NEVER calls a model API. The model does the interpretation
// (normalization / assembly); the runner does the deterministic part (routing,
// lifecycle, privacy, provenance, id minting). This keeps the probabilistic /
// deterministic boundary clean and preserves every invariant in kernel/BOOT.md:
// append-only claims, generated (never hand-edited) views, source on every
// claim, human ratification of captured facts. Zero external dependencies — it
// composes the tools already in this directory. No database, embeddings, graph
// engine, service, or network.
//
// Usage:
//   node tools/runner.mjs project [--entity <id>]... [--adapter gpt|gemini]
//                                 [--include-private -o <private/path>]
//                                 [-o <file>]            # else prints to stdout
//   node tools/runner.mjs capture <envelope.jsonl> [--apply]   # default: dry-run
//
// See kernel/BOOT.md and kernel/ontology.yaml for the layer/precedence contract.

import fs from "node:fs";
import path from "node:path";

import { parseFrontMatter } from "./validate.mjs";
import { loadClaims, loadEntities, classify, governing } from "./generate-views.mjs";
import { validateClaimShape } from "./validate-claims.mjs";
import { scanContent, scanSensitiveData } from "./privacy-check.mjs";

const ROOT = path.resolve(".");
const TODAY = new Date().toISOString().slice(0, 10);
const PRIVATE_CLASSES = new Set(["restricted", "sensitive"]);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------------------
// Shared: routing + id minting (deterministic)
// ---------------------------------------------------------------------------

/**
 * Deterministic claim-log path for an entity. Mirrors the store convention:
 * `organization:acme` -> claims/organization-acme.jsonl, and a
 * restricted/sensitive claim routes under private/ (git-excluded).
 * @param {string} entityId e.g. "organization:acme"
 * @param {string} classification
 * @param {string} root
 */
export function claimLogPath(entityId, classification, root = ROOT) {
  const file = `${entityId.replace(/:/g, "-")}.jsonl`;
  const dir = PRIVATE_CLASSES.has(classification)
    ? path.join(root, "private", "claims")
    : path.join(root, "claims");
  return path.join(dir, file);
}

/**
 * Next sequential claim id for a domain, given all known claims. Ids look like
 * `clm-<domain>-NNNN`; this returns the max+1 for that domain, zero-padded to
 * the widest existing width (>= 4). Deterministic and append-safe.
 * @param {object[]} claims all loaded claims
 * @param {string} domain short id token, e.g. "acme"
 */
export function nextClaimId(claims, domain) {
  const re = new RegExp(`^clm-${domain}-(\\d+)$`);
  let max = 0;
  let width = 4;
  for (const c of claims) {
    const m = typeof c.id === "string" && c.id.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
    if (m[1].length > width) width = m[1].length;
  }
  return `clm-${domain}-${String(max + 1).padStart(width, "0")}`;
}

// ---------------------------------------------------------------------------
// project (egress): assemble a portable context package
// ---------------------------------------------------------------------------

/** Read a Markdown file's body (front matter stripped), or "" if absent. */
function readBody(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return "";
  const text = fs.readFileSync(abs, "utf8");
  const { found, endLine } = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const body = found ? lines.slice(endLine + 1).join("\n") : text;
  return body.trim();
}

/** Extract a `## Heading` section (heading + body up to the next `## `). */
function extractSection(md, heading) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/**
 * The write-back contract, projected from the single-source spec file
 * (inbox/capture-envelope-spec.md) so the bundle is self-contained for a model
 * with no file access. Returns null if the spec is absent (graceful fallback).
 */
export function captureContract(root = ROOT) {
  const spec = readBody(root, path.join("inbox", "capture-envelope-spec.md"));
  if (!spec) return null;
  const parts = [
    extractSection(spec, "## Envelope format"),
    extractSection(spec, "## Fidelity rules (normative)"),
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * Assemble the context package from canonical state.
 *
 * Minimal and honest by design (Design Principle 24, cm-cal-0002): it projects
 * ACTIVE claims (history dropped), the current-context snapshot, and — for
 * epistemic honesty — surfaces contradictions and open (unresolved) questions so
 * the receiving model inherits the uncertainty, not a false-confident summary.
 * Relevance ranking beyond an explicit entity filter is deliberately NOT
 * invented here; it awaits evidence of what selection is actually needed.
 *
 * Privacy: restricted/sensitive entities are excluded unless `includePrivate`
 * is set (which the CLI only permits when writing under private/).
 *
 * @param {string} root
 * @param {{ entities?: string[]|null, includePrivate?: boolean,
 *           adapter?: string|null, today?: string }} opts
 * @returns {{ markdown: string, manifest: object }}
 */
export function assembleContext(root = ROOT, opts = {}) {
  const { entities: filter = null, includePrivate = false, adapter = null, today = TODAY } = opts;

  const allClaims = loadClaims(root);
  let entities = loadEntities(root).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (filter && filter.length) {
    const want = new Set(filter);
    entities = entities.filter((e) => want.has(e.id));
  }
  if (!includePrivate) {
    entities = entities.filter((e) => !PRIVATE_CLASSES.has(e.classification));
  }

  const manifest = {
    generated: today,
    generator: "tools/runner.mjs project",
    include_private: includePrivate,
    adapter: adapter || null,
    entities: [],
    claim_ids: [],
  };

  const lines = [];
  lines.push("---");
  lines.push("title: AxiomCE — projected context package");
  lines.push("type: context-bundle");
  lines.push(`classification: ${includePrivate ? "restricted" : "personal"}`);
  lines.push("generated: true");
  lines.push(`updated: ${today}`);
  lines.push("source: tools/runner.mjs");
  lines.push("---");
  lines.push("");
  lines.push("<!-- DO NOT EDIT. Generated by tools/runner.mjs (project). Regenerate to refresh. -->");
  if (includePrivate) {
    lines.push("<!-- LOCAL-ONLY: contains restricted/sensitive facts. Never commit or paste into a remote/logged service. -->");
  }
  lines.push("");
  lines.push("# AxiomCE — context package");
  lines.push("");
  lines.push("Hand this to a new AI session to transfer accumulated continuity. It is a");
  lines.push("**projection** of the canonical store, not the store itself: active facts only,");
  lines.push("with contradictions and open questions surfaced so you inherit the uncertainty");
  lines.push("honestly. To write anything back, return an agent-normalized candidate-claims");
  lines.push("envelope for `tools/runner.mjs capture` — do not treat this bundle as editable.");
  lines.push("");
  lines.push(`- **Generated:** ${today} · **Scope:** ${includePrivate ? "full (incl. private)" : "public + personal only"}`);
  if (adapter) lines.push(`- **Collaboration adapter:** \`${adapter}\``);
  lines.push("");

  // --- Knowledge: active facts per entity ---
  lines.push("## What is known (active facts)");
  lines.push("");
  if (entities.length === 0) {
    lines.push("_No entities in scope._");
    lines.push("");
  }
  for (const e of entities) {
    const mine = allClaims.filter((c) => c.entity === e.id).sort(byId);
    const { active, contradictions } = classify(mine, today);
    manifest.entities.push(e.id);
    lines.push(`### ${e.title} \`${e.id}\``);
    lines.push("");
    if (active.length === 0) {
      lines.push("_No active claims._");
      lines.push("");
      continue;
    }
    const contradicted = new Set([...contradictions.keys()]);
    // One line per active predicate; for a contradicted predicate, name the
    // governing claim (safety-first precedence) rather than silently picking.
    const seen = new Set();
    for (const c of active.slice().sort((a, b) =>
      a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : byId(a, b))) {
      manifest.claim_ids.push(c.id);
      if (contradicted.has(c.predicate)) {
        if (seen.has(c.predicate)) continue;
        seen.add(c.predicate);
        const list = contradictions.get(c.predicate);
        const gov = governing(list);
        lines.push(`- **${c.predicate}** ⚠ _(contradicted — ${list.length} active; rely on \`${gov.id}\`, ${gov.confidence})_: ${gov.value}`);
        for (const alt of list.sort(byId)) {
          if (alt.id === gov.id) continue;
          lines.push(`  - also active: ${alt.value} _(${alt.confidence}; ${alt.id})_`);
        }
      } else {
        lines.push(`- **${c.predicate}** _(${c.confidence})_: ${c.value}`);
      }
    }
    lines.push("");
  }

  // --- Current context snapshot ---
  const cur = readBody(root, "CURRENT_CONTEXT.md");
  lines.push("## Current context");
  lines.push("");
  lines.push(cur ? cur : "_No CURRENT_CONTEXT.md found._");
  lines.push("");

  // --- Open questions across scope (active + unresolved) ---
  const open = [];
  for (const e of entities) {
    const mine = allClaims.filter((c) => c.entity === e.id);
    const { active } = classify(mine, today);
    for (const c of active.filter((c) => c.confidence === "unresolved").sort(byId)) {
      open.push({ entity: e.id, c });
    }
  }
  lines.push("## Open questions (unresolved — do not guess past these)");
  lines.push("");
  if (open.length === 0) lines.push("_None recorded in scope._");
  else for (const o of open) lines.push(`- \`${o.entity}\` **${o.c.predicate}**: ${o.c.value} (\`${o.c.id}\`)`);
  lines.push("");

  // --- Collaboration policy (how to work with the human) ---
  lines.push("## How to collaborate");
  lines.push("");
  lines.push("Canonical collaboration policy lives in `cognitive-model/policy/` (stable `CM-*`");
  lines.push("rule ids). Honor honest epistemic labeling (verified / assumed / inferred /");
  lines.push("unknown), surface tradeoffs before artifacts, and match effort to task size.");
  if (adapter) {
    const shim = readBody(root, path.join("cognitive-model", "adapters", `${adapter}.md`));
    if (shim) {
      lines.push("");
      lines.push(`### Adapter: ${adapter} (presentation shim)`);
      lines.push("");
      lines.push(shim);
    }
  }
  lines.push("");

  // --- Write-back contract (how to return memory faithfully) ---
  const contract = captureContract(root);
  lines.push("## Writing back (capture contract)");
  lines.push("");
  lines.push("To return memory to the store, emit an agent-normalized candidate-claims");
  lines.push("envelope for `tools/runner.mjs capture`. Structure and privacy are enforced");
  lines.push("deterministically; the rules below are what preserve *meaning* — the engine");
  lines.push("cannot see a dropped negation, a fused compound, or an inflated confidence.");
  lines.push("");
  if (contract) {
    lines.push("Source of truth: `inbox/capture-envelope-spec.md`.");
    lines.push("");
    lines.push(contract);
  } else {
    lines.push("See `inbox/capture-envelope-spec.md` for the normalization contract.");
  }
  manifest.capture_contract = contract ? "inbox/capture-envelope-spec.md" : null;
  lines.push("");

  // --- Reproducibility manifest (the "context manifest") ---
  lines.push("## Provenance manifest");
  lines.push("");
  lines.push("This projection is reproducible from the exact inputs below.");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(manifest, null, 2));
  lines.push("```");
  lines.push("");

  return { markdown: lines.join("\n") + "\n", manifest };
}

// ---------------------------------------------------------------------------
// capture (ingest): validate + route an agent-normalized candidate envelope
// ---------------------------------------------------------------------------

/**
 * Plan a capture from a candidate-claims envelope. Pure/deterministic: computes
 * the minted claim, target log, and any blocking problems WITHOUT writing.
 *
 * Each envelope line is a claim object as normalized by a model. It MUST carry
 * `entity`, `predicate`, `value`, `confidence`, `classification`, `valid_from`,
 * and `source`. It MAY omit `id` and `asserted_at` (the runner mints them); it
 * MUST provide `id_domain` (short id token, e.g. "acme") when `id` is omitted.
 *
 * @param {string} root
 * @param {string} envelopePath
 * @param {{ now?: string }} opts
 * @returns {{ planned: object[], problems: Array<{line:number,msg:string}> }}
 *   planned entries: { line, claim, target (rel path), private (bool), warns[] }
 */
export function planCapture(root, envelopePath, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const problems = [];
  const planned = [];

  if (!fs.existsSync(envelopePath)) {
    return { planned, problems: [{ line: 0, msg: `envelope not found: ${envelopePath}` }] };
  }

  const entityIds = new Set(loadEntities(root).map((e) => e.id));
  // Start from the live store so minted ids never collide, then track ids minted
  // in this batch so multiple new claims in the same domain stay sequential.
  const known = loadClaims(root);
  const mintedIds = [];

  const text = fs.readFileSync(envelopePath, "utf8");
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith("//")) return;
    const lineNo = i + 1;

    let obj;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      problems.push({ line: lineNo, msg: `malformed JSON: ${e.message}` });
      return;
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      problems.push({ line: lineNo, msg: "candidate is not a JSON object" });
      return;
    }

    // Mint id + asserted_at if absent.
    const idDomain = obj.id_domain;
    delete obj.id_domain; // not part of the claim schema
    if (!obj.id) {
      if (!idDomain || typeof idDomain !== "string") {
        problems.push({ line: lineNo, msg: "missing id and id_domain (need one to mint an id)" });
        return;
      }
      const minted = nextClaimId([...known, ...mintedIds.map((id) => ({ id }))], idDomain);
      obj.id = minted;
      mintedIds.push(minted);
    }
    if (!obj.asserted_at) obj.asserted_at = now;

    // Structural validation (schema/enums/dates/ids).
    const shapeProblems = validateClaimShape(obj);
    for (const m of shapeProblems) problems.push({ line: lineNo, msg: m });

    // Referential: entity must exist.
    if (typeof obj.entity === "string" && !entityIds.has(obj.entity)) {
      problems.push({ line: lineNo, msg: `references missing entity: ${obj.entity} (create the entity first)` });
    }

    // Privacy gate. Never-store secrets ALWAYS block. Sensitive-data heuristics
    // block only when the claim would land in a TRACKED log; under private/ that
    // content is allowed (authoritative local context).
    const target = claimLogPath(obj.entity || "unknown:unknown", obj.classification, root);
    const isPrivate = PRIVATE_CLASSES.has(obj.classification);
    const scanText = `${obj.value || ""}\n${obj.note || ""}`;
    const { blocks: secretBlocks, warns } = scanContent(scanText);
    for (const b of secretBlocks) problems.push({ line: lineNo, msg: `never-store secret — ${b}` });
    if (!isPrivate) {
      for (const b of scanSensitiveData(scanText)) {
        problems.push({ line: lineNo, msg: `sensitive data in a tracked claim — ${b}; set classification restricted/sensitive so it routes to private/` });
      }
    }

    if (shapeProblems.length === 0) {
      planned.push({
        line: lineNo,
        claim: obj,
        target: path.relative(root, target),
        private: isPrivate,
        warns,
      });
    }
  });

  return { planned, problems };
}

/**
 * Apply a planned capture: append each claim to its target log (append-only),
 * UTF-8 without BOM, one JSON object per line. Creates the log if absent.
 * @param {string} root
 * @param {object[]} planned output of planCapture().planned
 * @returns {{ appended: Array<{id:string,target:string}> }}
 */
export function applyCapture(root, planned) {
  const appended = [];
  // Group by target so we open each file once and keep order stable.
  const byTarget = new Map();
  for (const p of planned) {
    if (!byTarget.has(p.target)) byTarget.set(p.target, []);
    byTarget.get(p.target).push(p.claim);
  }
  for (const [rel, claims] of byTarget) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    if (existing && !existing.endsWith("\n")) existing += "\n";
    const additions = claims.map((c) => JSON.stringify(c)).join("\n") + "\n";
    // UTF-8, no BOM.
    fs.writeFileSync(abs, existing + additions, { encoding: "utf8" });
    for (const c of claims) appended.push({ id: c.id, target: rel });
  }
  return { appended };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], entity: [], adapter: null, includePrivate: false, apply: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--entity") out.entity.push(argv[++i]);
    else if (a === "--adapter") out.adapter = argv[++i];
    else if (a === "--include-private") out.includePrivate = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "-o" || a === "--out") out.out = argv[++i];
    else out._.push(a);
  }
  return out;
}

function runProject(opts) {
  if (opts.includePrivate) {
    // Refuse to emit restricted content to stdout or a tracked path.
    const dest = opts.out ? opts.out.replace(/\\/g, "/") : null;
    if (!dest || !/(^|\/)private\//.test(dest)) {
      console.error("project --include-private requires -o <path under private/> (restricted content must never hit stdout or a tracked file).");
      process.exit(1);
    }
  }
  const { markdown } = assembleContext(ROOT, {
    entities: opts.entity.length ? opts.entity : null,
    includePrivate: opts.includePrivate,
    adapter: opts.adapter,
  });
  if (opts.out) {
    const abs = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, markdown, { encoding: "utf8" });
    console.error(`project: wrote ${path.relative(ROOT, abs)} (${markdown.length} bytes).`);
  } else {
    process.stdout.write(markdown);
  }
}

function runCapture(opts) {
  const envelope = opts._[0];
  if (!envelope) {
    console.error("capture: missing <envelope.jsonl>. Usage: runner.mjs capture <envelope.jsonl> [--apply]");
    process.exit(1);
  }
  const { planned, problems } = planCapture(ROOT, path.resolve(envelope), {});
  for (const p of problems) console.error(`FAIL line ${p.line}: ${p.msg}`);
  for (const p of planned) {
    for (const w of p.warns) console.error(`WARN line ${p.line}: ${w}`);
  }
  if (problems.length) {
    console.error(`\ncapture: ${problems.length} problem(s); nothing written.`);
    process.exit(1);
  }
  if (!opts.apply) {
    console.log(`capture (dry-run): ${planned.length} claim(s) would be appended:`);
    for (const p of planned) console.log(`  ${p.claim.id} -> ${p.target}  (${p.claim.confidence}, ${p.claim.classification})`);
    console.log("\nReview, then re-run with --apply. Captured claims land PENDING human ratification.");
    process.exit(0);
  }
  const { appended } = applyCapture(ROOT, planned);
  for (const a of appended) console.log(`appended ${a.id} -> ${a.target}`);
  console.log(`\ncapture: ${appended.length} claim(s) appended. Regenerate views (node tools/generate-views.mjs) and ratify.`);
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (cmd === "project") runProject(opts);
  else if (cmd === "capture") runCapture(opts);
  else {
    console.error("Usage:\n  runner.mjs project [--entity <id>]... [--adapter gpt|gemini] [-o <file>] [--include-private -o <private/path>]\n  runner.mjs capture <envelope.jsonl> [--apply]");
    process.exit(1);
  }
}
