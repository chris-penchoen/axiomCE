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
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { parseFrontMatter } from "./validate.mjs";
import { loadClaims, loadEntities, classify, governing, generateAll } from "./generate-views.mjs";
import { validateClaimShape } from "./validate-claims.mjs";
import { scanContent, scanSensitiveData } from "./privacy-check.mjs";

const ROOT = path.resolve(".");
const TODAY = new Date().toISOString().slice(0, 10);
const PRIVATE_CLASSES = new Set(["restricted", "sensitive"]);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------------------
// runtime layer: operational state, kept OUTSIDE the human knowledge model
// ---------------------------------------------------------------------------
//
// The runner's own bookkeeping (dedup ledger, ratification queue, run
// manifests) lives under runtime/ (public/personal) and private/runtime/
// (restricted/sensitive, git-excluded). It never mixes with continuity state
// (claims/, entities/). This is the runtime-vs-continuity boundary: knowledge
// must not depend on runner internals, and runner internals must not pollute
// the ontology.

const OBSERVATIONS_DIR = "inbox/observations";

/** Resolve the runtime state paths, routed public vs private by sensitivity. */
function runtimePaths(root = ROOT, isPrivate = false) {
  const base = isPrivate ? path.join(root, "private", "runtime") : path.join(root, "runtime");
  return {
    dir: base,
    ledger: path.join(base, "ledger.jsonl"),
    queue: path.join(base, "ratification-queue.jsonl"),
    // Tracked run manifests carry public ids/counts only; private detail goes
    // to private/runtime/runs (git-excluded), routed by `isPrivate`.
    runs: path.join(base, "runs"),
  };
}

/**
 * Stable content hash for a candidate claim — the idempotency key (`obs_id`).
 * Hashes ONLY the semantic fields, never the minted id or asserted_at (which
 * vary per run), so re-observing identical content is a guaranteed no-op
 * regardless of source file or when it was seen.
 * @param {object} obj a parsed candidate claim
 * @returns {string} e.g. "obs-1a2b3c4d5e6f7a8b"
 */
export function candidateHash(obj) {
  const semantic = {
    entity: obj.entity ?? null,
    predicate: obj.predicate ?? null,
    value: obj.value ?? null,
    confidence: obj.confidence ?? null,
    classification: obj.classification ?? null,
    valid_from: obj.valid_from ?? null,
    valid_to: obj.valid_to ?? null,
    retracted_at: obj.retracted_at ?? null,
    supersedes: obj.supersedes ?? null,
    note: obj.note ?? null,
    source: obj.source ?? null,
  };
  const canon = JSON.stringify(semantic, Object.keys(semantic).sort());
  return "obs-" + crypto.createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/**
 * Read a JSONL file into parsed objects (skips blank/`//` lines). Operational
 * files (ledger/queue/canon) are machine-written, so a malformed line means
 * corruption — surface it loudly rather than silently forgetting state.
 */
function readJsonl(abs) {
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith("//")) return;
    try {
      out.push(JSON.parse(t));
    } catch (e) {
      throw new Error(`corrupt operational JSONL at ${abs}:${i + 1} — ${e.message} (recover/repair before continuing; malformed audit state is never silently skipped)`);
    }
  });
  return out;
}

/**
 * Write a file atomically: write to a temp sibling, fsync, then rename over the
 * target. Rename is atomic on a single filesystem, so a crash mid-write can
 * never leave a truncated/partial file — readers see either the old or the new
 * complete content. Creates parent dirs as needed. UTF-8, no BOM.
 */
function atomicWrite(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, abs);
}

/** Append objects to a JSONL file (append-only, atomic), creating dirs. */
function appendJsonl(abs, objs) {
  if (!objs.length) return;
  let existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  if (existing && !existing.endsWith("\n")) existing += "\n";
  atomicWrite(abs, existing + objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

/** Overwrite a JSONL file with the given objects (atomic; rewrites the queue). */
function writeJsonl(abs, objs) {
  atomicWrite(abs, objs.length ? objs.map((o) => JSON.stringify(o)).join("\n") + "\n" : "");
}

/** True if a PID is live on this host (best-effort; EPERM still means alive). */
function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * Run `fn` while holding an exclusive runtime writer lock. All state-changing
 * operations (sync apply, ratify apply, privileged import) share this single
 * lock so concurrent processes cannot interleave read-modify-write on the
 * ledger/queue/canon. Zero-dependency: an O_EXCL lockfile under runtime/.
 * Recovers a stale lock only when its owning PID is dead or it has aged out.
 */
function withWriterLock(root, fn) {
  const lockPath = path.join(root, "runtime", "writer.lock");
  const STALE_MS = 60_000;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  if (fs.existsSync(lockPath)) {
    let stale = false;
    try {
      const info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const age = Date.now() - new Date(info.acquired_at).getTime();
      const sameHostAlive = info.host === os.hostname() && isPidAlive(info.pid);
      stale = !sameHostAlive || age > STALE_MS;
    } catch { stale = true; }
    if (stale) { try { fs.rmSync(lockPath, { force: true }); } catch { /* race: reacquire below */ } }
  }

  let fd;
  try {
    fd = fs.openSync(lockPath, "wx"); // exclusive create — fails if held
  } catch (e) {
    if (e.code === "EEXIST") {
      throw new Error("runtime is locked by another writer (runtime/writer.lock). Wait for it to finish, or remove the lock if you are sure it is stale.");
    }
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), acquired_at: new Date().toISOString(), cmd: process.argv.slice(2).join(" ") }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort release */ }
  }
}

/**
 * Reduce the append-only ledger (public + private) to the latest status per
 * obs_id. Returns a Map obs_id -> latest entry.
 */
export function loadLedger(root = ROOT) {
  const entries = [
    ...readJsonl(runtimePaths(root, false).ledger),
    ...readJsonl(runtimePaths(root, true).ledger),
  ];
  const latest = new Map();
  for (const e of entries) {
    if (e && e.obs_id) latest.set(e.obs_id, e); // later lines win (chronological)
  }
  return latest;
}

/** Load queued (pending) claims from the public + private queues. */
export function loadQueue(root = ROOT) {
  return [
    ...readJsonl(runtimePaths(root, false).queue),
    ...readJsonl(runtimePaths(root, true).queue),
  ];
}

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
 * Evaluate a single candidate claim: mint id/asserted_at if absent, then run
 * the structural + referential + privacy gates. Mutates `obj` (adds id,
 * asserted_at; strips id_domain). Deterministic; writes nothing. Shared by
 * `capture` and `sync` so both apply the exact same gates.
 *
 * @param {object} obj parsed candidate (may carry id_domain)
 * @param {{root:string, entityIds:Set<string>, known:object[], mintedIds:string[], now:string}} ctx
 * @returns {{problems:string[], warns:string[], target:string|null, private:boolean, shapeOk:boolean}}
 */
export function evaluateCandidate(obj, ctx) {
  const { root, entityIds, known, mintedIds, now } = ctx;
  const problems = [];

  // Mint id + asserted_at if absent.
  const idDomain = obj.id_domain;
  delete obj.id_domain; // not part of the claim schema
  if (!obj.id) {
    if (!idDomain || typeof idDomain !== "string") {
      problems.push("missing id and id_domain (need one to mint an id)");
      return { problems, warns: [], target: null, private: false, shapeOk: false };
    }
    const minted = nextClaimId([...known, ...mintedIds.map((id) => ({ id }))], idDomain);
    obj.id = minted;
    mintedIds.push(minted);
  } else {
    // Externally-supplied id: enforce uniqueness NOW against canon, queued, and
    // ids minted/seen earlier in this batch — otherwise a duplicate canonical id
    // could slip through and only be caught by the whole-store validator later.
    const clash = known.some((k) => k.id === obj.id) || mintedIds.includes(obj.id);
    if (clash) {
      problems.push(`duplicate claim id: ${obj.id} (already present in canon, the ratification queue, or earlier in this batch)`);
    }
    mintedIds.push(obj.id);
  }
  if (!obj.asserted_at) obj.asserted_at = now;

  // Structural validation (schema/enums/dates/ids).
  const shapeProblems = validateClaimShape(obj);
  for (const m of shapeProblems) problems.push(m);

  // Referential: entity must exist.
  if (typeof obj.entity === "string" && !entityIds.has(obj.entity)) {
    problems.push(`references missing entity: ${obj.entity} (create the entity first)`);
  }

  // Privacy gate. Never-store secrets ALWAYS block. Sensitive-data heuristics
  // block only when the claim would land in a TRACKED log; under private/ that
  // content is allowed (authoritative local context).
  const target = claimLogPath(obj.entity || "unknown:unknown", obj.classification, root);
  const isPrivate = PRIVATE_CLASSES.has(obj.classification);
  const scanText = `${obj.value || ""}\n${obj.note || ""}`;
  const { blocks: secretBlocks, warns } = scanContent(scanText);
  for (const b of secretBlocks) problems.push(`never-store secret — ${b}`);
  if (!isPrivate) {
    for (const b of scanSensitiveData(scanText)) {
      problems.push(`sensitive data in a tracked claim — ${b}; set classification restricted/sensitive so it routes to private/`);
    }
  }

  return {
    problems,
    warns,
    target: path.relative(root, target),
    private: isPrivate,
    shapeOk: shapeProblems.length === 0,
  };
}

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

    const res = evaluateCandidate(obj, { root, entityIds, known, mintedIds, now });
    for (const m of res.problems) problems.push({ line: lineNo, msg: m });
    if (res.shapeOk) {
      planned.push({
        line: lineNo,
        claim: obj,
        target: res.target,
        private: res.private,
        warns: res.warns,
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
    let existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    if (existing && !existing.endsWith("\n")) existing += "\n";
    const additions = claims.map((c) => JSON.stringify(c)).join("\n") + "\n";
    atomicWrite(abs, existing + additions); // temp+fsync+rename; UTF-8, no BOM
    for (const c of claims) appended.push({ id: c.id, target: rel });
  }
  return { appended };
}

// ---------------------------------------------------------------------------
// sync (continuous ingest): observe -> dedup -> gate -> ratification queue
// ---------------------------------------------------------------------------

/**
 * Plan a sync: scan inbox/observations/*.jsonl, dedup against the ledger, run
 * the same gates as capture, and route NEW valid claims toward the ratification
 * queue (never straight to canon). Pure/deterministic — writes nothing.
 *
 * Idempotency: each candidate is hashed (semantic content only) BEFORE minting.
 * Anything whose hash is already in the ledger — or seen earlier in this run —
 * is skipped, so re-running (or `--watch` re-firing) is a safe no-op.
 *
 * @param {string} root
 * @param {{ now?: string }} opts
 * @returns {{ queued:object[], duplicates:object[], problems:object[], files:string[] }}
 */
export function planSync(root = ROOT, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const dir = path.join(root, OBSERVATIONS_DIR);
  const queued = [];
  const duplicates = [];
  const problems = [];

  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()
    : [];

  const entityIds = new Set(loadEntities(root).map((e) => e.id));
  const ledger = loadLedger(root);
  // Seed minting from canon + already-queued claims so new ids stay sequential
  // and never collide with pending (not-yet-ratified) claims.
  const known = [...loadClaims(root), ...loadQueue(root).map((q) => ({ id: q.claim.id }))];
  const mintedIds = [];
  const seenThisRun = new Set();

  for (const f of files) {
    const abs = path.join(dir, f);
    fs.readFileSync(abs, "utf8").split(/\r?\n/).forEach((raw, i) => {
      const t = raw.trim();
      if (!t || t.startsWith("//")) return;
      const lineNo = i + 1;

      let obj;
      try { obj = JSON.parse(t); } catch (e) {
        problems.push({ file: f, line: lineNo, msg: `malformed JSON: ${e.message}` });
        return;
      }
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
        problems.push({ file: f, line: lineNo, msg: "candidate is not a JSON object" });
        return;
      }

      // Idempotency check BEFORE minting (hash of semantic fields only).
      const obsId = candidateHash(obj);
      if (ledger.has(obsId) || seenThisRun.has(obsId)) {
        duplicates.push({ obs_id: obsId, source_file: f, line: lineNo, status: ledger.get(obsId)?.status || "queued" });
        return;
      }
      seenThisRun.add(obsId);

      const res = evaluateCandidate(obj, { root, entityIds, known, mintedIds, now });
      for (const m of res.problems) problems.push({ file: f, line: lineNo, msg: m });
      // Only fully-clean candidates are queued (sync may run unattended).
      if (res.shapeOk && res.problems.length === 0) {
        queued.push({
          obs_id: obsId,
          claim: obj,
          target: res.target,
          private: res.private,
          source_file: f,
          line: lineNo,
          warns: res.warns,
        });
      }
    });
  }

  return { queued, duplicates, problems, files };
}

/**
 * Apply a planned sync: append queued claims to the ratification queue and
 * record them in the ledger (both routed public/private by classification),
 * then write a run manifest. Never touches canonical claim logs.
 * @param {string} root
 * @param {object} plan output of planSync()
 * @param {{ now?: string }} opts
 * @returns {{ queuedCount:number, runManifestPath:string }}
 */
export function applySync(root = ROOT, plan, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const stamp = now.replace(/[:.]/g, "-");
  const pub = runtimePaths(root, false);
  const prv = runtimePaths(root, true);

  // Apply-time idempotency (belt-and-suspenders vs a crash between the queue and
  // ledger writes of a prior run): re-read the ledger + live queue NOW and drop
  // any candidate whose obs_id is already recorded, so a re-run cannot enqueue a
  // duplicate under a fresh claim id.
  const seen = new Set();
  for (const isPrivate of [false, true]) {
    const rp = runtimePaths(root, isPrivate);
    for (const rec of readJsonl(rp.ledger)) if (rec.obs_id) seen.add(rec.obs_id);
    for (const q of readJsonl(rp.queue)) if (q.obs_id) seen.add(q.obs_id);
  }
  const fresh = plan.queued.filter((q) => !seen.has(q.obs_id));

  const queueBucket = { false: [], true: [] };
  const ledgerBucket = { false: [], true: [] };
  for (const q of fresh) {
    const key = String(q.private);
    queueBucket[key].push({
      obs_id: q.obs_id,
      claim: q.claim,
      target: q.target,
      private: q.private,
      source_file: q.source_file,
      line: q.line,
      queued_at: now,
    });
    ledgerBucket[key].push({
      obs_id: q.obs_id,
      claim_id: q.claim.id,
      status: "queued",
      classification: q.claim.classification,
      source_file: q.source_file,
      first_seen: now,
    });
  }

  appendJsonl(pub.queue, queueBucket["false"]);
  appendJsonl(pub.ledger, ledgerBucket["false"]);
  appendJsonl(prv.queue, queueBucket["true"]);
  appendJsonl(prv.ledger, ledgerBucket["true"]);

  // Manifests are split by privacy so the TRACKED record can never leak private
  // identifiers, targets, or source filenames:
  //  - tracked runtime/runs/<stamp>.json  : aggregate counts + PUBLIC items only
  //  - private/runtime/runs/<stamp>.json  : full detail incl. observed files +
  //    private items (git-excluded).
  const publicItems = fresh.filter((q) => !q.private)
    .map((q) => ({ obs_id: q.obs_id, claim_id: q.claim.id, target: q.target }));
  const privateItems = fresh.filter((q) => q.private)
    .map((q) => ({ obs_id: q.obs_id, claim_id: q.claim.id, target: q.target }));

  const trackedManifest = {
    run: stamp,
    generator: "tools/runner.mjs sync",
    queued: publicItems,                 // public only — never claim values
    private_queued_count: privateItems.length,
    duplicates: plan.duplicates.length,
    problems: plan.problems.length,
  };
  const runPath = path.join(pub.runs, `${stamp}.json`);
  atomicWrite(runPath, JSON.stringify(trackedManifest, null, 2) + "\n");

  // Private detailed manifest — only when there is private detail to record.
  if (privateItems.length || plan.files.length) {
    const privateManifest = {
      run: stamp,
      generator: "tools/runner.mjs sync",
      observed_files: plan.files,        // filenames can reveal people/projects
      public_queued: publicItems,
      private_queued: privateItems,
      duplicates: plan.duplicates.length,
      problems: plan.problems.length,
    };
    const privRunPath = path.join(prv.runs, `${stamp}.json`);
    atomicWrite(privRunPath, JSON.stringify(privateManifest, null, 2) + "\n");
  }

  return { queuedCount: fresh.length, runManifestPath: path.relative(root, runPath) };
}

// ---------------------------------------------------------------------------
// ratify (human gate): promote queued claims into canon (or discard)
// ---------------------------------------------------------------------------

/**
 * Plan a ratification: select pending queued claims to promote (or discard).
 * @param {string} root
 * @param {{ ids?:string[], all?:boolean }} opts  ids match obs_id OR claim.id
 * @returns {{ promote:object[], problems:object[] }}
 */
export function planRatify(root = ROOT, opts = {}) {
  const queue = loadQueue(root);
  const problems = [];
  let selected;
  if (opts.all) {
    selected = queue;
  } else {
    const want = new Set(opts.ids || []);
    selected = queue.filter((q) => want.has(q.obs_id) || want.has(q.claim.id));
    for (const id of want) {
      if (!queue.some((q) => q.obs_id === id || q.claim.id === id)) {
        problems.push({ id, msg: "not found in ratification queue" });
      }
    }
  }
  const promote = selected.map((q) => ({ queueEntry: q, target: q.target, claim: q.claim, private: q.private }));
  return { promote, problems };
}

/**
 * Apply a ratification: promote (append to canon via applyCapture) or discard
 * the selected queued claims, remove them from the queue, and append a
 * status-transition record to the ledger. Caller regenerates views.
 * @param {string} root
 * @param {object} plan output of planRatify()
 * @param {{ now?:string, discard?:boolean }} opts
 * @returns {{ appended:object[], discarded:number }}
 */
export function applyRatify(root = ROOT, plan, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const discard = !!opts.discard;

  // Idempotent-by-claim-id: if a prior ratification crashed AFTER appending to
  // canon but BEFORE removing the queue entry, re-running must not append the
  // same claim twice. Skip promotes whose claim.id is already present in the
  // target canon file — but still remove them from the queue and record the
  // transition, so the crash-interrupted step completes cleanly on retry.
  let promote = plan.promote;
  let alreadyCanon = [];
  if (!discard) {
    const canonIds = new Map(); // target rel -> Set of ids present
    const idsFor = (target) => {
      if (!canonIds.has(target)) {
        const abs = path.join(root, target);
        canonIds.set(target, new Set(readJsonl(abs).map((c) => c.id)));
      }
      return canonIds.get(target);
    };
    alreadyCanon = plan.promote.filter((p) => idsFor(p.target).has(p.claim.id));
    promote = plan.promote.filter((p) => !idsFor(p.target).has(p.claim.id));
  }

  let appended = [];
  if (!discard && promote.length) {
    ({ appended } = applyCapture(root, promote.map((p) => ({ target: p.target, claim: p.claim }))));
  }

  // Remove promoted/discarded entries (including already-canonical ones) from
  // whichever queue (pub/prv) holds them.
  const doneObs = new Set(plan.promote.map((p) => p.queueEntry.obs_id));
  for (const isPrivate of [false, true]) {
    const qp = runtimePaths(root, isPrivate).queue;
    if (fs.existsSync(qp)) writeJsonl(qp, readJsonl(qp).filter((q) => !doneObs.has(q.obs_id)));
  }

  // Append status-transition ledger records (routed by the claim's privacy).
  // Entries that were already in canon are recorded as ratified too (the
  // promotion is complete either way), keeping ledger/canon consistent.
  const led = { false: [], true: [] };
  for (const p of plan.promote) {
    const rec = { obs_id: p.queueEntry.obs_id, claim_id: p.claim.id, status: discard ? "discarded" : "ratified" };
    rec[discard ? "discarded_at" : "ratified_at"] = now;
    led[String(p.private)].push(rec);
  }
  appendJsonl(runtimePaths(root, false).ledger, led["false"]);
  appendJsonl(runtimePaths(root, true).ledger, led["true"]);

  return { appended, discarded: discard ? plan.promote.length : 0, alreadyCanon: alreadyCanon.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], entity: [], adapter: null, includePrivate: false, apply: false, out: null,
                watch: false, ids: [], all: false, discard: false, trust: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--entity") out.entity.push(argv[++i]);
    else if (a === "--adapter") out.adapter = argv[++i];
    else if (a === "--include-private") out.includePrivate = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--trust") out.trust = true;
    else if (a === "--watch") out.watch = true;
    else if (a === "--id") out.ids.push(argv[++i]);
    else if (a === "--all") out.all = true;
    else if (a === "--discard") out.discard = true;
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

function runImportCanonical(opts) {
  const envelope = opts._[0];
  if (!envelope) {
    console.error("import-canonical: missing <envelope.jsonl>. Usage: runner.mjs import-canonical <envelope.jsonl> --trust [--apply]");
    process.exit(1);
  }
  // This command DELIBERATELY bypasses the ratification queue and writes
  // straight to canon. It is a privileged administrative import, so it demands
  // an explicit --trust acknowledgement that the source is authoritative.
  if (!opts.trust) {
    console.error("import-canonical writes directly to canon, bypassing human ratification.");
    console.error("Re-run with --trust to confirm the envelope is an authoritative source.");
    console.error("For untrusted/model-proposed observations use `sync` instead (routes through the ratification queue).");
    process.exit(1);
  }
  const { planned, problems } = planCapture(ROOT, path.resolve(envelope), {});
  for (const p of problems) console.error(`FAIL line ${p.line}: ${p.msg}`);
  for (const p of planned) {
    for (const w of p.warns) console.error(`WARN line ${p.line}: ${w}`);
  }
  if (problems.length) {
    console.error(`\nimport-canonical: ${problems.length} problem(s); nothing written.`);
    process.exit(1);
  }
  if (!opts.apply) {
    console.log(`import-canonical (dry-run): ${planned.length} claim(s) would be written DIRECTLY to canon (bypassing ratification):`);
    for (const p of planned) console.log(`  ${p.claim.id} -> ${p.target}  (${p.claim.confidence}, ${p.claim.classification})`);
    console.log("\nRe-run with --apply to write. These claims become canonical immediately — they are NOT queued for ratification.");
    process.exit(0);
  }
  const { appended } = withWriterLock(ROOT, () => applyCapture(ROOT, planned));
  for (const a of appended) console.log(`imported ${a.id} -> ${a.target} (canonical)`);
  console.log(`\nimport-canonical: ${appended.length} claim(s) written directly to canon. Regenerate views (node tools/generate-views.mjs).`);
  process.exit(0);
}

function runSync(opts) {
  const runOnce = () => {
    const plan = planSync(ROOT, {});
    for (const p of plan.problems) console.error(`FAIL ${p.file}:${p.line}: ${p.msg}`);
    for (const q of plan.queued) for (const w of q.warns) console.error(`WARN ${q.source_file}:${q.line}: ${w}`);

    if (!opts.apply) {
      console.log(`sync (dry-run): ${plan.queued.length} new claim(s) would be queued, ${plan.duplicates.length} duplicate(s) skipped, ${plan.problems.length} problem(s).`);
      for (const q of plan.queued) console.log(`  + ${q.claim.id} <- ${q.source_file}:${q.line}  (${q.claim.confidence}, ${q.claim.classification})${q.private ? " [private]" : ""} -> queue`);
      if (plan.queued.length) console.log(`\nRe-run with --apply to enqueue, then: node tools/runner.mjs ratify --all`);
      return plan;
    }
    if (plan.problems.length) {
      console.error(`\nsync: ${plan.problems.length} problem(s); nothing enqueued (fix or remove the offending observation).`);
      return plan;
    }
    const { queuedCount, runManifestPath } = withWriterLock(ROOT, () => applySync(ROOT, plan, {}));
    console.log(`sync: ${queuedCount} claim(s) enqueued for ratification; ${plan.duplicates.length} duplicate(s) skipped. Manifest: ${runManifestPath}`);
    if (queuedCount) console.log(`Review: node tools/runner.mjs ratify --all   (or --id <clm-...>)`);
    return plan;
  };

  if (!opts.watch) {
    const plan = runOnce();
    process.exit(opts.apply && plan.problems.length ? 1 : 0);
  }

  // --watch: debounced re-run on observation-drop changes. Zero-dep fs.watch.
  const dir = path.join(ROOT, OBSERVATIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  console.error(`sync --watch: watching ${OBSERVATIONS_DIR}/ (Ctrl-C to stop).`);
  runOnce();
  let timer = null;
  fs.watch(dir, { persistent: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { runOnce(); } catch (e) { console.error(`sync error: ${e.message}`); } }, 300);
  });
}

function runRatify(opts) {
  if (!opts.all && opts.ids.length === 0) {
    console.error("ratify: specify --all or one/more --id <obs_id|claim_id>. Add --discard to drop instead of promote.");
    process.exit(1);
  }
  const plan = planRatify(ROOT, { ids: opts.ids, all: opts.all });
  for (const p of plan.problems) console.error(`FAIL ${p.id}: ${p.msg}`);
  if (plan.promote.length === 0) {
    console.log("ratify: nothing to promote (queue empty or no match).");
    process.exit(plan.problems.length ? 1 : 0);
  }
  const verb = opts.discard ? "discard" : "promote";
  if (!opts.apply) {
    console.log(`ratify (dry-run): would ${verb} ${plan.promote.length} claim(s):`);
    for (const p of plan.promote) console.log(`  ${p.claim.id} -> ${opts.discard ? "discarded" : p.target}  (${p.claim.confidence}, ${p.claim.classification})`);
    console.log(`\nRe-run with --apply to ${verb}.`);
    process.exit(plan.problems.length ? 1 : 0);
  }
  const { appended, discarded, alreadyCanon } = withWriterLock(ROOT, () => applyRatify(ROOT, plan, { discard: opts.discard }));
  if (opts.discard) {
    console.log(`ratify: discarded ${discarded} queued claim(s).`);
  } else {
    for (const a of appended) console.log(`ratified ${a.id} -> ${a.target}`);
    if (alreadyCanon) console.log(`(${alreadyCanon} already in canon from an interrupted run — queue reconciled, not re-appended.)`);
    generateAll(ROOT, { check: false }); // refresh views to reflect new canon
    console.log(`\nratify: ${appended.length} claim(s) promoted to canon; views regenerated.`);
  }
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (cmd === "project") runProject(opts);
  else if (cmd === "import-canonical") runImportCanonical(opts);
  else if (cmd === "capture") {
    console.error("note: `capture` is deprecated and renamed to `import-canonical` (it bypasses ratification; requires --trust).");
    runImportCanonical(opts);
  }
  else if (cmd === "sync") runSync(opts);
  else if (cmd === "ratify") runRatify(opts);
  else {
    console.error([
      "Usage:",
      "  runner.mjs project [--entity <id>]... [--adapter gpt|gemini] [-o <file>] [--include-private -o <private/path>]",
      "  runner.mjs import-canonical <envelope.jsonl> --trust [--apply]   # PRIVILEGED: writes straight to canon, bypasses ratification",
      "  runner.mjs sync [--apply] [--watch]                 # observe inbox/observations/ -> ratification queue",
      "  runner.mjs ratify (--all | --id <id>...) [--discard] [--apply]   # promote queued claims into canon",
    ].join("\n"));
    process.exit(1);
  }
}
