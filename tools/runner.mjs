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
import { loadClaims, loadEntities, classify, governing, evidenceWeight, contradictionAgeDays, generateAll } from "./generate-views.mjs";
import { validateClaimShape } from "./validate-claims.mjs";
import { scanContent, scanSensitiveData } from "./privacy-check.mjs";

const ROOT = path.resolve(".");
const TODAY = new Date().toISOString().slice(0, 10);
// Fail-closed privacy: a claim/entity is treated as PUBLIC (tracked, may enter
// public artifacts) ONLY if its classification is one of these explicit public
// classes. Anything else — restricted/sensitive, but also null/missing/unknown
// — routes to private/ (git-excluded) and is excluded from public surfaces.
// Unclassified content is quarantined, never leaked.
const PUBLIC_CLASSES = new Set(["public", "personal"]);
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
    // Append-only audit of delegated (policy-driven) ratification decisions
    // (Axiom 18 guardrail #2). Routed public/private like everything else.
    audit: path.join(base, "delegated-audit.jsonl"),
    // Quarantine for candidates that failed the gates (rt-dead-letter). A poison
    // record no longer aborts the whole sync run — it is set aside here so the
    // clean candidates still make progress. Written PRIVATE-only (see
    // applyDeadLetter): a rejected candidate's classification is untrusted and
    // its raw content may hold sensitive data, so quarantine is fail-closed.
    deadLetter: path.join(base, "dead-letter.jsonl"),
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
    // Guard every mutation: migrate the store forward to the engine's schema
    // version, or refuse if it was written by a newer engine. Runs inside the
    // lock so migration is serialized with all other writers.
    ensureSchema(root);
    return fn();
  } finally {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort release */ }
  }
}

// ---------------------------------------------------------------------------
// Runtime schema versioning + migration scaffold (rt-schema-versioning)
// ---------------------------------------------------------------------------

// Bump when the on-disk shape of ANY operational runtime file (ledger, queue,
// run manifest, delegated-audit, dead-letter) changes, and append a matching
// entry to MIGRATIONS. A distributable store may be written by one engine
// version and read by another across machines/time, so the store carries an
// explicit version and mutations migrate-forward or refuse.
export const RUNTIME_SCHEMA_VERSION = 1;

/** Path to the runtime store's schema marker (public partition = the authority). */
function schemaVersionPath(root = ROOT) {
  return path.join(root, "runtime", "schema.json");
}

/** True if any operational runtime file already exists (store is in use). */
function runtimeStoreExists(root = ROOT) {
  for (const isPrivate of [false, true]) {
    const rp = runtimePaths(root, isPrivate);
    for (const f of [rp.ledger, rp.queue, rp.audit, rp.deadLetter]) {
      if (fs.existsSync(f)) return true;
    }
    if (fs.existsSync(rp.runs) && fs.readdirSync(rp.runs).length) return true;
  }
  return false;
}

/**
 * Read the runtime store's declared schema version.
 *  - marker present            -> its schema_version
 *  - marker absent, store empty -> RUNTIME_SCHEMA_VERSION (a fresh store is current)
 *  - marker absent, store in use -> 0 (a legacy store written before versioning)
 */
export function readSchemaVersion(root = ROOT) {
  const p = schemaVersionPath(root);
  if (fs.existsSync(p)) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8")).schema_version;
      if (Number.isInteger(v) && v >= 0) return v;
    } catch { /* fall through */ }
    return 0; // present but unreadable -> treat as legacy; migration re-stamps it
  }
  return runtimeStoreExists(root) ? 0 : RUNTIME_SCHEMA_VERSION;
}

// Ordered migrations. Each { from, to, migrate(root) } transforms the store in
// place. v1 is the first versioned shape, so 0->1 only stamps the marker (the
// pre-versioning shape is identical to v1). Future shape changes append
// { from: 1, to: 2, migrate }, etc. — never renumber existing steps.
export const MIGRATIONS = [
  { from: 0, to: 1, migrate: (_root) => { /* pre-versioning shape == v1; no transform */ } },
];

function writeSchemaVersion(root, version, now) {
  atomicWrite(
    schemaVersionPath(root),
    JSON.stringify({ schema_version: version, updated_at: now || new Date().toISOString() }, null, 2) + "\n"
  );
}

/**
 * Ensure the runtime store is at RUNTIME_SCHEMA_VERSION before any mutation.
 * Migrates forward through MIGRATIONS when behind; REFUSES when the store was
 * written by a NEWER engine (declared > current) so a distributable never
 * silently corrupts a store it doesn't understand. Must run under the writer
 * lock (it is invoked from withWriterLock). Deterministic; `opts.now` threads
 * the marker timestamp for tests.
 * @returns {{ from:number, to:number, migrated:boolean }}
 */
export function ensureSchema(root = ROOT, opts = {}) {
  const declared = readSchemaVersion(root);
  if (declared > RUNTIME_SCHEMA_VERSION) {
    throw new Error(
      `runtime store schema v${declared} is newer than this engine (v${RUNTIME_SCHEMA_VERSION}). ` +
      `Upgrade tools/runner.mjs before writing — refusing to avoid corrupting a store written by a newer version.`
    );
  }
  if (declared === RUNTIME_SCHEMA_VERSION) {
    if (!fs.existsSync(schemaVersionPath(root))) writeSchemaVersion(root, RUNTIME_SCHEMA_VERSION, opts.now);
    return { from: declared, to: declared, migrated: false };
  }
  let v = declared;
  while (v < RUNTIME_SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === v);
    if (!step) throw new Error(`no migration registered from runtime schema v${v} to v${v + 1}`);
    step.migrate(root);
    v = step.to;
  }
  writeSchemaVersion(root, RUNTIME_SCHEMA_VERSION, opts.now);
  return { from: declared, to: RUNTIME_SCHEMA_VERSION, migrated: true };
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

/**
 * Stable quarantine key for a raw observation line — a hash of the exact trimmed
 * text. Independent of file/line (which shift), so a dead-lettered poison line
 * is recognized and skipped on every later sync until the source is edited (an
 * edit changes the text -> new key -> reprocessed normally). Distinct from
 * candidateHash, which needs parseable semantic fields a malformed line lacks.
 */
export function deadLetterKey(rawTrimmed) {
  return "dl-" + crypto.createHash("sha256").update(rawTrimmed).digest("hex").slice(0, 32);
}

/** Set of quarantine keys already recorded (public + private dead-letter logs). */
export function loadDeadLetter(root = ROOT) {
  const keys = new Set();
  for (const isPrivate of [false, true]) {
    for (const rec of readJsonl(runtimePaths(root, isPrivate).deadLetter)) {
      if (rec && rec.dl_key) keys.add(rec.dl_key);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Shared: routing + id minting (deterministic)
// ---------------------------------------------------------------------------

/**
 * Deterministic claim-log path for an entity. Mirrors the store convention:
 * `organization:acme` -> claims/organization-acme.jsonl. Fail-closed: a claim
 * routes to the TRACKED public log only when its classification is an explicit
 * public class (public/personal); everything else — including missing/unknown —
 * routes under private/ (git-excluded) so unclassified content never leaks.
 * @param {string} entityId e.g. "organization:acme"
 * @param {string} classification
 * @param {string} root
 */
export function claimLogPath(entityId, classification, root = ROOT) {
  const file = `${entityId.replace(/:/g, "-")}.jsonl`;
  const dir = PUBLIC_CLASSES.has(classification)
    ? path.join(root, "claims")
    : path.join(root, "private", "claims");
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
    entities = entities.filter((e) => PUBLIC_CLASSES.has(e.classification));
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
    const { active, contradictions, dormant, corroborated } = classify(mine, today);
    manifest.entities.push(e.id);
    lines.push(`### ${e.title} \`${e.id}\``);
    lines.push("");
    if (active.length === 0) {
      lines.push("_No active claims._");
      lines.push("");
      continue;
    }
    const contradicted = new Set([...contradictions.keys()]);
    const parked = new Set([...dormant.keys()]);
    const agreed = new Set([...corroborated.keys()]);
    // One line per active predicate; for a contradicted predicate, name the
    // evidence-weighted governing default (Axiom 10) rather than silently picking.
    const seen = new Set();
    for (const c of active.slice().sort((a, b) =>
      a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : byId(a, b))) {
      manifest.claim_ids.push(c.id);
      if (contradicted.has(c.predicate)) {
        if (seen.has(c.predicate)) continue;
        seen.add(c.predicate);
        const list = contradictions.get(c.predicate);
        const gov = governing(list);
        const govW = evidenceWeight(gov, list);
        // Faithful rendering (Axiom 11): a live contradiction is presented AS
        // unresolved — never downplayed to a single claim to "rely on". The
        // governing pick is an evidence-weighted DEFAULT (Axiom 10: evidence
        // outranks confidence, tiebroken by confidence-label precedence), shown
        // to surface the best-supported side — NOT a resolution. Auto-resolving
        // a contradiction requires the ratified decisive-evidence bar under
        // policy (Axiom 18); until then every side stays visible and open.
        lines.push(`- **${c.predicate}** ⚠ _(UNRESOLVED contradiction — ${list.length} active claims; not auto-resolved)_`);
        lines.push(`  - governing default \`${gov.id}\` _(${gov.confidence}; ${govW} src; evidence-weighted per Axiom 10, not a settled ruling)_: ${gov.value}`);
        for (const alt of list.sort(byId)) {
          if (alt.id === gov.id) continue;
          const altW = evidenceWeight(alt, list);
          lines.push(`  - also active: ${alt.value} _(${alt.confidence}; ${altW} src; ${alt.id})_`);
        }
      } else if (parked.has(c.predicate)) {
        if (seen.has(c.predicate)) continue;
        seen.add(c.predicate);
        const list = dormant.get(c.predicate);
        const gov = governing(list);
        const govW = evidenceWeight(gov, list);
        const age = contradictionAgeDays(list, today);
        // Dormant contradiction (Axiom 12): parked off the active "needs-you"
        // surface after sitting past the threshold with no new evidence, but
        // kept visible (Axiom 11: no concealment). Parking is NOT resolution —
        // both sides remain; a newer claim reactivates it automatically.
        lines.push(`- **${c.predicate}** 💤 _(DORMANT contradiction — parked, ${list.length} active claims, ${age}d since last evidence; not resolved)_`);
        lines.push(`  - evidence-weighted default \`${gov.id}\` _(${gov.confidence}; ${govW} src)_: ${gov.value}`);
        for (const alt of list.sort(byId)) {
          if (alt.id === gov.id) continue;
          const altW = evidenceWeight(alt, list);
          lines.push(`  - also active: ${alt.value} _(${alt.confidence}; ${altW} src; ${alt.id})_`);
        }
      } else if (agreed.has(c.predicate)) {
        if (seen.has(c.predicate)) continue;
        seen.add(c.predicate);
        const list = corroborated.get(c.predicate);
        const gov = governing(list);
        const w = evidenceWeight(gov, list);
        // Corroboration (Axiom 9): >1 active claim, all the same value from
        // independent sources. Agreement, not conflict — shown once, positively.
        lines.push(`- **${c.predicate}** ✓ _(corroborated by ${w} source${w === 1 ? "" : "s"})_: ${gov.value}`);
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
  const isPrivate = !PUBLIC_CLASSES.has(obj.classification);
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
 * True only for a FINAL, safe-to-read observation drop. A producer publishes
 * atomically (write a temp/hidden file, fsync, rename into place — see
 * publishObservation), so an in-progress drop is never a bare `*.jsonl`:
 *   - must end in `.jsonl`               (final extension)
 *   - must NOT be hidden (leading `.`)   (the staging convention)
 *   - must NOT carry a temp/partial/backup marker
 * This is the consumer half of the atomic-publish contract: it guarantees
 * `sync`/`sync --watch` never reads a half-written file (rt-atomic-observe).
 */
export function isObservationFile(name) {
  if (typeof name !== "string" || !name.endsWith(".jsonl")) return false;
  if (name.startsWith(".")) return false;
  if (/(\.tmp|\.partial|\.swp|~)$/i.test(name) || /\.tmp-/i.test(name)) return false;
  return true;
}

/** List final observation files in `dir`, sorted. Skips in-progress drops. */
export function observationFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isObservationFile).sort();
}

/**
 * Reference producer: publish an observation drop ATOMICALLY so a consumer never
 * reads a half-written file. Writes to a HIDDEN temp in the same directory
 * (fsynced) then renames into the final name — rename is atomic on one
 * filesystem, so the `*.jsonl` appears whole or not at all, and the hidden temp
 * is skipped by isObservationFile if observed mid-flight. Producers written in
 * another language MUST follow the same contract: write temp+hidden, fsync,
 * rename to a bare final `*.jsonl`. Never append incrementally to a live
 * `*.jsonl` in the watched directory.
 * @returns {string} the final published path
 */
export function publishObservation(dir, name, content) {
  if (typeof name !== "string" || !name.endsWith(".jsonl") || name.startsWith(".") ||
      name.includes("/") || name.includes("\\") || /\.tmp-|\.(tmp|partial|swp)$|~$/i.test(name)) {
    throw new Error(`publishObservation: name must be a bare final '*.jsonl' file, got '${name}'`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content.endsWith("\n") ? content : content + "\n", { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const final = path.join(dir, name);
  fs.renameSync(tmp, final);
  return final;
}

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

  const files = observationFiles(dir);

  const entityIds = new Set(loadEntities(root).map((e) => e.id));
  const ledger = loadLedger(root);
  const deadLettered = loadDeadLetter(root);
  // Group per-line failures so each poison line becomes ONE quarantine record
  // (a candidate can raise several problem messages). Keyed by dl_key.
  const dlMap = new Map();
  let quarantinedSkipped = 0;
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
      const dlKey = deadLetterKey(t);
      // Already quarantined on a prior run: skip so it never blocks progress or
      // re-floods problems. It stays set-aside until the source line is edited.
      if (deadLettered.has(dlKey)) { quarantinedSkipped++; return; }

      const fail = (msg) => {
        problems.push({ file: f, line: lineNo, msg });
        if (!dlMap.has(dlKey)) dlMap.set(dlKey, { dl_key: dlKey, source_file: f, line: lineNo, raw: t, problems: [] });
        dlMap.get(dlKey).problems.push(msg);
      };

      let obj;
      try { obj = JSON.parse(t); } catch (e) {
        fail(`malformed JSON: ${e.message}`);
        return;
      }
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
        fail("candidate is not a JSON object");
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
      for (const m of res.problems) fail(m);
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

  return { queued, duplicates, problems, files, deadLetters: [...dlMap.values()], quarantinedSkipped };
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
    schema_version: RUNTIME_SCHEMA_VERSION,
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
      schema_version: RUNTIME_SCHEMA_VERSION,
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

/**
 * Quarantine failed candidates (rt-dead-letter). Appends one record per poison
 * line to the PRIVATE dead-letter log (fail-closed: a rejected candidate's
 * classification is untrusted and its raw text may hold sensitive data, so it
 * must never land in a tracked file). Recording the dl_key lets later syncs skip
 * the same bad line instead of re-failing on it forever. Idempotent: keys
 * already present are not appended again.
 * @param {string} root
 * @param {object[]} deadLetters  plan.deadLetters
 * @param {{ now?:string }} opts
 * @returns {{ quarantined:number }}
 */
export function applyDeadLetter(root = ROOT, deadLetters, opts = {}) {
  if (!deadLetters || !deadLetters.length) return { quarantined: 0 };
  const now = opts.now || new Date().toISOString();
  const existing = loadDeadLetter(root);
  const fresh = deadLetters.filter((d) => !existing.has(d.dl_key));
  if (!fresh.length) return { quarantined: 0 };
  const records = fresh.map((d) => ({
    dl_key: d.dl_key,
    source_file: d.source_file,
    line: d.line,
    problems: d.problems,
    raw: d.raw,
    quarantined_at: now,
  }));
  // Always private/ — quarantine is fail-closed.
  appendJsonl(runtimePaths(root, true).deadLetter, records);
  return { quarantined: records.length };
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
// recover (state reconciliation): detect + repair an inconsistent runtime store
// ---------------------------------------------------------------------------

/**
 * Detect inconsistencies between the three runtime state layers — the ledger
 * (append-only status log, latest-per-obs_id), the ratification queue (pending
 * claims), and canon (ratified claims). Pure/read-only. These states arise from
 * interrupted writes (a crash between two appends), manual edits, or partial
 * restores across machines. Each finding carries a severity:
 *   repairable  a deterministic, provenance-preserving fix exists (applyRecover)
 *   manual      real data loss — a human must re-observe/re-ratify; NEVER auto
 *   info        benign + expected (e.g. a direct `capture` bypasses the ledger)
 * @returns {{ findings: object[] }}
 */
export function planRecover(root = ROOT) {
  const findings = [];
  const ledgerLatest = loadLedger(root);                 // obs_id -> latest entry
  const canon = loadClaims(root);
  const canonIds = new Set(canon.map((c) => c.id));

  // obs_id -> partition (first queue it appears in) + the queue entry itself.
  const obsPartition = new Map();
  const queueEntryByObs = new Map();
  const obsCount = new Map();
  for (const isPrivate of [false, true]) {
    for (const q of readJsonl(runtimePaths(root, isPrivate).queue)) {
      if (!q || !q.obs_id) continue;
      obsCount.set(q.obs_id, (obsCount.get(q.obs_id) || 0) + 1);
      if (!obsPartition.has(q.obs_id)) obsPartition.set(q.obs_id, isPrivate);
      if (!queueEntryByObs.has(q.obs_id)) queueEntryByObs.set(q.obs_id, q);
    }
  }
  const ratifiedClaimIds = new Set();
  for (const e of ledgerLatest.values())
    if (e.status === "ratified" && e.claim_id) ratifiedClaimIds.add(e.claim_id);

  // 1. duplicate obs_ids in the queue (idempotency breach — same content twice).
  for (const [obs, n] of obsCount) {
    if (n > 1) findings.push({ type: "DUPLICATE_OBS_IN_QUEUE", severity: "repairable", obs_id: obs,
      detail: `${n} queue entries share obs_id ${obs}`, repair: "keep the first, drop the duplicates" });
  }
  // 2. stale queue entry: ledger already ratified/discarded but still queued
  //    (crash after the ledger append, before the queue removal).
  for (const obs of queueEntryByObs.keys()) {
    const led = ledgerLatest.get(obs);
    if (led && (led.status === "ratified" || led.status === "discarded"))
      findings.push({ type: "STALE_QUEUE_ENTRY", severity: "repairable", obs_id: obs,
        detail: `queue holds obs_id ${obs} but ledger status is '${led.status}'`,
        repair: "remove the completed entry from the queue" });
  }
  // 3. queue entry with no ledger record at all (enqueue half-committed).
  for (const obs of queueEntryByObs.keys()) {
    if (!ledgerLatest.has(obs))
      findings.push({ type: "UNTRACKED_QUEUE", severity: "repairable", obs_id: obs,
        detail: `queue holds obs_id ${obs} with no ledger record`,
        repair: "append a 'queued' ledger record to match the queue" });
  }
  // 4. ledger says queued: reconcile forward if canon already has it, else it is
  //    a lost pending payload (ledger only stores ids, not the claim body).
  for (const [obs, e] of ledgerLatest) {
    if (e.status !== "queued") continue;
    if (e.claim_id && canonIds.has(e.claim_id))
      findings.push({ type: "LEDGER_BEHIND_CANON", severity: "repairable", obs_id: obs, claim_id: e.claim_id,
        detail: `ledger says ${obs} is queued but claim ${e.claim_id} is already in canon`,
        repair: "append a 'ratified' ledger record to match canon" });
    else if (!queueEntryByObs.has(obs))
      findings.push({ type: "LOST_QUEUED", severity: "manual", obs_id: obs, claim_id: e.claim_id || null,
        detail: `ledger says ${obs} is queued but it is absent from both queue and canon — the pending payload is lost; re-observe the source`,
        repair: null });
  }
  // 5. ledger says ratified but the claim is missing from canon (canon write
  //    lost). Recoverable only if the payload still sits in the queue.
  for (const [obs, e] of ledgerLatest) {
    if (e.status === "ratified" && e.claim_id && !canonIds.has(e.claim_id)) {
      const inQueue = queueEntryByObs.has(obs);
      findings.push({ type: "LOST_CANON", severity: "manual", obs_id: obs, claim_id: e.claim_id,
        detail: inQueue
          ? `ledger says ${e.claim_id} was ratified but it is not in canon — payload still in queue; run \`ratify --id ${obs} --apply\` to complete it`
          : `ledger says ${e.claim_id} was ratified but it is not in canon and the payload is gone — re-observe the source`,
        repair: null });
    }
  }
  // 6. canon claim with no ratifying ledger record. Benign + expected for claims
  //    written directly via `capture`/`import-canonical`, which bypass the queue.
  for (const c of canon) {
    if (!ratifiedClaimIds.has(c.id))
      findings.push({ type: "ORPHAN_CANON", severity: "info", claim_id: c.id,
        detail: `canon claim ${c.id} has no 'ratified' ledger record (expected for a direct capture)`,
        repair: null });
  }
  return { findings };
}

/**
 * Apply ONLY the deterministic, provenance-preserving repairs from a recover
 * plan, under the writer lock. Repairs are append-only on the ledger and
 * removal-only on the queue — canon is never touched, and no ratification event
 * is fabricated for a claim that was not actually in canon. Reconciling ledger
 * records are marked `reconciled: true` so the repair is itself auditable.
 * Recompute the plan INSIDE the lock (pass a fresh planRecover) to avoid acting
 * on a stale view. `manual`/`info` findings are ignored here by design.
 * @returns {{ applied: object[] }}
 */
export function applyRecover(root = ROOT, plan, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const canonById = new Map(loadClaims(root).map((c) => [c.id, c]));

  const removeObs = { false: new Set(), true: new Set() };
  const dedupObs = new Set();
  const ledgerAppend = { false: [], true: [] };

  // Locate each obs_id's partition + queue entry (fresh read under the lock).
  const obsPartition = new Map();
  const queueEntryByObs = new Map();
  for (const isPrivate of [false, true]) {
    for (const q of readJsonl(runtimePaths(root, isPrivate).queue)) {
      if (!q || !q.obs_id) continue;
      if (!obsPartition.has(q.obs_id)) obsPartition.set(q.obs_id, isPrivate);
      if (!queueEntryByObs.has(q.obs_id)) queueEntryByObs.set(q.obs_id, q);
    }
  }

  const applied = [];
  for (const f of plan.findings) {
    if (f.type === "STALE_QUEUE_ENTRY") {
      const p = obsPartition.get(f.obs_id);
      if (p === undefined) continue;
      removeObs[String(p)].add(f.obs_id);
      applied.push(f);
    } else if (f.type === "DUPLICATE_OBS_IN_QUEUE") {
      dedupObs.add(f.obs_id);
      applied.push(f);
    } else if (f.type === "UNTRACKED_QUEUE") {
      const p = obsPartition.get(f.obs_id);
      const entry = queueEntryByObs.get(f.obs_id);
      if (p === undefined || !entry) continue;
      ledgerAppend[String(p)].push({ obs_id: f.obs_id, claim_id: entry.claim?.id ?? null, status: "queued", first_seen: now, reconciled: true });
      applied.push(f);
    } else if (f.type === "LEDGER_BEHIND_CANON") {
      const c = canonById.get(f.claim_id);
      if (!c) continue; // canon changed since planning — skip, re-plan will catch it
      const isPrivate = !PUBLIC_CLASSES.has(c.classification);
      ledgerAppend[String(isPrivate)].push({ obs_id: f.obs_id, claim_id: f.claim_id, status: "ratified", ratified_at: now, reconciled: true });
      applied.push(f);
    }
    // LOST_QUEUED / LOST_CANON / ORPHAN_CANON: never auto-repaired.
  }

  // Rewrite queues (removal-only): drop stale entries + collapse duplicates.
  for (const isPrivate of [false, true]) {
    const key = String(isPrivate);
    const qp = runtimePaths(root, isPrivate).queue;
    if (!fs.existsSync(qp)) continue;
    const before = readJsonl(qp);
    const seen = new Set();
    const after = [];
    for (const q of before) {
      if (removeObs[key].has(q.obs_id)) continue;
      if (dedupObs.has(q.obs_id)) {
        if (seen.has(q.obs_id)) continue;
        seen.add(q.obs_id);
      }
      after.push(q);
    }
    if (after.length !== before.length) writeJsonl(qp, after);
  }

  // Append reconciling ledger records (routed by privacy).
  appendJsonl(runtimePaths(root, false).ledger, ledgerAppend["false"]);
  appendJsonl(runtimePaths(root, true).ledger, ledgerAppend["true"]);

  return { applied };
}

// ---------------------------------------------------------------------------
// triage (queue surfacing): sort the pending ratification queue into buckets
// ---------------------------------------------------------------------------

// Buckets in PRIORITY order (most safety-constraining first). Each queued item
// lands in exactly one bucket. `privacy-hold` and `needs-clarification` are the
// classes HARD-excluded from any delegated automation (Axiom 18 guardrail #4).
export const TRIAGE_BUCKETS = ["privacy-hold", "needs-clarification", "contradiction", "ready"];

/**
 * Categorize a single queued claim against the entity's current canon claims.
 * Deterministic; a categorizer, NOT a gate — nothing is blocked, only sorted
 * (the safety-floor logic reused for surfacing):
 *   privacy-hold        not an explicit public class — restricted/sensitive OR
 *                       missing/unknown classification (never auto-anything)
 *   needs-clarification confidence === "unresolved" (a human must clarify)
 *   contradiction       promoting would create/join a LIVE contradiction on the
 *                       entity+predicate (real disagreement needing attention)
 *   ready               clean: settled confidence, public/personal, no conflict
 */
export function triageBucket(claim, canonForEntity = [], today = TODAY) {
  if (!PUBLIC_CLASSES.has(claim.classification)) return "privacy-hold";
  if (claim.confidence === "unresolved") return "needs-clarification";
  const { contradictions } = classify([...canonForEntity, claim], today);
  if (contradictions.has(claim.predicate)) return "contradiction";
  return "ready";
}

/**
 * Triage the whole pending queue (public + private) into buckets. Pure/
 * deterministic: reads canon + queue, writes nothing. Realizes the "surface
 * contradictions / where I'm needed" view.
 */
export function triageQueue(root = ROOT, opts = {}) {
  const today = opts.today || TODAY;
  const queue = loadQueue(root);
  const canon = loadClaims(root);
  const byEntity = new Map();
  for (const c of canon) {
    if (!byEntity.has(c.entity)) byEntity.set(c.entity, []);
    byEntity.get(c.entity).push(c);
  }
  const buckets = {};
  for (const b of TRIAGE_BUCKETS) buckets[b] = [];
  for (const q of queue) {
    const bucket = triageBucket(q.claim, byEntity.get(q.claim.entity) || [], today);
    buckets[bucket].push(q);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// delegated ratification (Axiom 18): human-authored policy MAY auto-promote the
// clean bucket and surface decisively-resolvable contradictions. The DEFAULT
// policy is the SAFE FLOOR — ZERO automation: every item is surfaced for human
// ratification ("sampling starts at 100% surfaced; the human ramps automation
// UP over time"). Policy is human-authored, never model-self-certified.
// Reversible (Axiom 24); every decision is audited (guardrail #2).
// ---------------------------------------------------------------------------

// public < personal < sensitive < restricted (sensitivity ascending).
const CLASSIFICATION_ORDER = ["public", "personal", "sensitive", "restricted"];

/** True iff `cls` is at or below `ceiling` on the sensitivity scale. Unknown → false (fail-closed). */
export function classAtOrBelow(cls, ceiling) {
  const a = CLASSIFICATION_ORDER.indexOf(cls);
  const b = CLASSIFICATION_ORDER.indexOf(ceiling);
  return a !== -1 && b !== -1 && a <= b;
}

// The single human-authored policy knob-set. Defaults = do nothing automatically.
export const DEFAULT_RATIFY_POLICY = {
  autoRatifyReady: false,           // (a) auto-promote the clean/ready bucket?
  classificationCeiling: "public",  // ...only at/below this classification
  decisiveSourceRatio: 3,           // (b) distinct-source ratio bar (ax10 weight)
};

/**
 * Decide whether a contradiction is DECISIVELY resolvable by evidence alone
 * (Axiom 10 weight). Deterministic. Groups the contending claims by
 * whitespace-normalized value, weights each by DISTINCT sources, and checks
 * whether the top value dominates the runner-up by >= `ratio`.
 *
 * HONEST SCOPE: the ratified bar ALSO requires "the losing side has no higher
 * provenance-TIER confirming source" and an "authoritative-source"
 * disconfirmation branch. The claim schema models provenance as a single
 * `source` STRING with NO tier, so those clauses are UNCOMPUTABLE. This checks
 * the computable half (distinct-source ratio) only — it is therefore ADVISORY:
 * it SURFACES "meets the N:1 ratio" for a human to confirm and does NOT
 * auto-write a contradiction resolution to canon. Full auto-resolve is blocked
 * on adding a provenance-tier field (a schema/canon change requiring
 * ratification).
 */
export function decisiveResolution(claimList, ratio = 3) {
  const norm = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
  const byValue = new Map(); // normalized value -> Set(source)
  for (const c of claimList) {
    const v = norm(c.value);
    if (!byValue.has(v)) byValue.set(v, new Set());
    byValue.get(v).add(c.source);
  }
  const ranked = [...byValue.entries()]
    .map(([value, sources]) => ({ value, weight: sources.size }))
    .sort((a, b) => b.weight - a.weight || (a.value < b.value ? -1 : 1));
  if (ranked.length < 2) {
    return { decisive: false, ratio, ranked, reason: "only one distinct value (agreement, not a genuine contradiction)" };
  }
  const [top, next] = ranked;
  const decisive = top.weight > next.weight && top.weight >= ratio * next.weight;
  return {
    decisive,
    ratio,
    winningValue: decisive ? top.value : null,
    topWeight: top.weight,
    runnerUpWeight: next.weight,
    ranked,
    reason: decisive
      ? `top value has ${top.weight} distinct sources vs ${next.weight} (>= ${ratio}:1)`
      : `top ${top.weight} vs runner-up ${next.weight} does not meet ${ratio}:1`,
  };
}

/**
 * Plan delegated ratification under a human-authored policy. Pure/deterministic;
 * writes nothing. Partitions the queue into:
 *   autoRatify  ready-bucket items the policy will auto-promote (clean, at/below
 *               the classification ceiling)
 *   resolvable  contradiction-bucket items meeting the evidence-ratio bar —
 *               SURFACED as "a human can confirm in one step" (advisory; NOT
 *               auto-written this build, pending a provenance-tier field)
 *   surfaced    everything else — needs a human (the default is EVERYTHING)
 * Every item yields an audit record. privacy-hold + needs-clarification are hard
 * excluded from autoRatify/resolvable by triage-bucket construction.
 */
export function planAutoRatify(root = ROOT, opts = {}) {
  const policy = { ...DEFAULT_RATIFY_POLICY, ...(opts.policy || {}) };
  const today = opts.today || TODAY;
  const now = opts.now || new Date().toISOString();
  const buckets = triageQueue(root, { today });
  const canon = loadClaims(root);
  const activeFor = (entity, predicate) =>
    classify(canon.filter((c) => c.entity === entity), today).active
      .filter((c) => c.predicate === predicate);

  const autoRatify = [];
  const resolvable = [];
  const surfaced = [];
  const audit = [];
  const rec = (q, bucket, action, reason) =>
    audit.push({ obs_id: q.obs_id, claim_id: q.claim.id, private: q.private, bucket, action, reason, decided_at: now });

  for (const q of buckets.ready) {
    const ok = policy.autoRatifyReady && classAtOrBelow(q.claim.classification, policy.classificationCeiling);
    if (ok) {
      autoRatify.push(q);
      rec(q, "ready", "auto-ratify", `clean; classification ${q.claim.classification} <= ceiling ${policy.classificationCeiling}`);
    } else {
      const why = !policy.autoRatifyReady
        ? "auto-ratify disabled (surfaced for human)"
        : `classification ${q.claim.classification} above ceiling ${policy.classificationCeiling}`;
      surfaced.push({ entry: q, bucket: "ready", why });
      rec(q, "ready", "surface", why);
    }
  }

  for (const q of buckets.contradiction) {
    const contending = [...activeFor(q.claim.entity, q.claim.predicate), q.claim];
    const decision = decisiveResolution(contending, policy.decisiveSourceRatio);
    if (decision.decisive) {
      resolvable.push({ entry: q, decision });
      rec(q, "contradiction", "surface-resolvable",
        `evidence-decisive (${decision.reason}); human confirmation required (auto-write deferred: no provenance tier)`);
    } else {
      surfaced.push({ entry: q, bucket: "contradiction", why: decision.reason });
      rec(q, "contradiction", "surface", decision.reason);
    }
  }

  for (const q of buckets["privacy-hold"]) {
    surfaced.push({ entry: q, bucket: "privacy-hold", why: "privacy-hold: hard-excluded from automation" });
    rec(q, "privacy-hold", "surface", "hard-excluded from automation");
  }
  for (const q of buckets["needs-clarification"]) {
    surfaced.push({ entry: q, bucket: "needs-clarification", why: "unresolved: hard-excluded from automation" });
    rec(q, "needs-clarification", "surface", "hard-excluded from automation");
  }

  return { autoRatify, resolvable, surfaced, audit, buckets, policy };
}

/** Append delegated-ratification audit entries, routed public/private (guardrail #2). */
function writeAuditLog(root, audit) {
  const pub = audit.filter((a) => !a.private);
  const prv = audit.filter((a) => a.private);
  if (pub.length) appendJsonl(runtimePaths(root, false).audit, pub);
  if (prv.length) appendJsonl(runtimePaths(root, true).audit, prv);
  return audit.length;
}

/**
 * Apply a delegated-ratification plan: promote the policy-approved `autoRatify`
 * (ready) items into canon by REUSING the human ratify path (applyRatify), and
 * append the audit log. `resolvable` contradictions are advisory and are NOT
 * written — they await human confirmation. Reversible (Axiom 24) via the same
 * retract/supersede paths as any ratified claim.
 */
export function applyAutoRatify(root = ROOT, plan) {
  const audited = writeAuditLog(root, plan.audit);
  if (plan.autoRatify.length === 0) return { appended: [], discarded: 0, alreadyCanon: 0, audited };
  const promote = plan.autoRatify.map((q) => ({ queueEntry: q, target: q.target, claim: q.claim, private: q.private }));
  const res = applyRatify(root, { promote }, {});
  return { ...res, audited };
}

// ---------------------------------------------------------------------------
// retract (Axiom 24): tombstone an active canonical claim with an audited reason
// ---------------------------------------------------------------------------

/**
 * Plan a retraction: locate ACTIVE canonical claims by id and mark them for
 * tombstoning. Pure/deterministic — writes nothing.
 *
 * A claim can be retracted only if it is currently active (not already
 * retracted, not superseded, not expired). Retracting history is a no-op we
 * surface as a problem so the operator knows nothing happened. Supersession and
 * retraction are distinct: supersede replaces a fact with a newer one; retract
 * withdraws a fact as wrong/void, keeping it in history (classify honors both).
 *
 * @param {string} root
 * @param {{ ids?:string[], today?:string }} opts  ids match claim.id
 * @returns {{ retract:object[], problems:object[] }}
 */
export function planRetract(root = ROOT, opts = {}) {
  const today = opts.today || TODAY;
  const canon = loadClaims(root);
  const byId = new Map(canon.map((c) => [c.id, c]));
  // Compute the active set with per-entity classify so supersession/expiry are
  // honored exactly as the view engine sees them.
  const byEntity = new Map();
  for (const c of canon) {
    if (!byEntity.has(c.entity)) byEntity.set(c.entity, []);
    byEntity.get(c.entity).push(c);
  }
  const activeIds = new Set();
  for (const [, list] of byEntity)
    for (const c of classify(list, today).active) activeIds.add(c.id);

  const retract = [];
  const problems = [];
  for (const id of opts.ids || []) {
    const claim = byId.get(id);
    if (!claim) { problems.push({ id, msg: "not found in canon" }); continue; }
    if (claim.retracted_at) { problems.push({ id, msg: "already retracted" }); continue; }
    if (!activeIds.has(id)) {
      problems.push({ id, msg: "not active (superseded or expired) — nothing to retract" });
      continue;
    }
    const target = path.relative(root, claimLogPath(claim.entity, claim.classification, root));
    retract.push({ claim, target, private: !PUBLIC_CLASSES.has(claim.classification) });
  }
  return { retract, problems };
}

/**
 * Apply a retraction: set retracted_at + retraction_reason on each targeted
 * claim IN PLACE (rewrite its canon log atomically), then append an audit
 * record routed public/private. Claims already carrying retracted_at are left
 * untouched (idempotent on retry). Caller regenerates views.
 *
 * @param {string} root
 * @param {object} plan output of planRetract()
 * @param {{ now?:string, reason:string }} opts
 * @returns {{ retracted:object[] }}
 */
export function applyRetract(root = ROOT, plan, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const reason = opts.reason;
  if (!reason || typeof reason !== "string" || reason.trim() === "") {
    throw new Error("applyRetract requires a non-empty reason (Axiom 24: retraction must be audited).");
  }
  const privById = new Map(plan.retract.map((r) => [r.claim.id, r.private]));
  // Group targeted ids by their canon log so each file is rewritten once.
  const byTarget = new Map();
  for (const r of plan.retract) {
    if (!byTarget.has(r.target)) byTarget.set(r.target, new Set());
    byTarget.get(r.target).add(r.claim.id);
  }
  const retracted = [];
  for (const [rel, idset] of byTarget) {
    const abs = path.join(root, rel);
    const claims = readJsonl(abs);
    let changed = false;
    for (const c of claims) {
      if (idset.has(c.id) && !c.retracted_at) {
        c.retracted_at = now;
        c.retraction_reason = reason;
        changed = true;
        retracted.push({ id: c.id, target: rel });
      }
    }
    if (changed) writeJsonl(abs, claims);
  }
  // Audit trail (reuse the append-only, privacy-routed audit log).
  const audit = retracted.map((r) => ({
    claim_id: r.id, private: privById.get(r.id) === true,
    action: "retract", reason, decided_at: now,
  }));
  writeAuditLog(root, audit);
  return { retracted };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], entity: [], adapter: null, includePrivate: false, apply: false, out: null,
                watch: false, ids: [], all: false, discard: false, trust: false, reason: null,
                autoReady: false, ceiling: null, ratio: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--entity") out.entity.push(argv[++i]);
    else if (a === "--adapter") out.adapter = argv[++i];
    else if (a === "--include-private") out.includePrivate = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--trust") out.trust = true;
    else if (a === "--watch") out.watch = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--id") out.ids.push(argv[++i]);
    else if (a === "--all") out.all = true;
    else if (a === "--discard") out.discard = true;
    else if (a === "--reason") out.reason = argv[++i];
    else if (a === "--auto-ready") out.autoReady = true;
    else if (a === "--ceiling") out.ceiling = argv[++i];
    else if (a === "--ratio") out.ratio = Number(argv[++i]);
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
      console.log(`sync (dry-run): ${plan.queued.length} new claim(s) would be queued, ${plan.duplicates.length} duplicate(s) skipped, ${plan.deadLetters.length} would be quarantined (${plan.problems.length} problem msg(s)), ${plan.quarantinedSkipped} already quarantined.`);
      for (const q of plan.queued) console.log(`  + ${q.claim.id} <- ${q.source_file}:${q.line}  (${q.claim.confidence}, ${q.claim.classification})${q.private ? " [private]" : ""} -> queue`);
      for (const d of plan.deadLetters) console.log(`  ! ${d.source_file}:${d.line} -> dead-letter (${d.problems.length} problem(s))`);
      if (plan.queued.length) console.log(`\nRe-run with --apply to enqueue, then: node tools/runner.mjs ratify --all`);
      return plan;
    }
    // Per-record quarantine (rt-dead-letter): failed candidates are set aside so
    // the clean ones still make progress — a poison record never aborts the run.
    const { queuedCount, runManifestPath } = withWriterLock(ROOT, () => {
      const dl = applyDeadLetter(ROOT, plan.deadLetters, {});
      const s = applySync(ROOT, plan, {});
      return { ...s, quarantined: dl.quarantined };
    });
    const dlCount = plan.deadLetters.length;
    console.log(`sync: ${queuedCount} claim(s) enqueued for ratification; ${plan.duplicates.length} duplicate(s) skipped; ${dlCount} quarantined to dead-letter; ${plan.quarantinedSkipped} already quarantined. Manifest: ${runManifestPath}`);
    if (queuedCount) console.log(`Review: node tools/runner.mjs ratify --all   (or --id <clm-...>)`);
    if (dlCount) console.log(`Quarantined (fix the source line, then re-sync): node tools/runner.mjs dead-letter`);
    return plan;
  };

  if (!opts.watch) {
    const plan = runOnce();
    // Quarantined records are NOT a run failure — that's the whole point. Exit 0.
    process.exit(0);
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

function runRetract(opts) {
  if (opts.ids.length === 0) {
    console.error("retract: specify one/more --id <claim_id> and a --reason \"<why>\".");
    process.exit(1);
  }
  if (!opts.reason || opts.reason.trim() === "") {
    console.error("retract: --reason \"<why>\" is required (Axiom 24: retraction must be audited).");
    process.exit(1);
  }
  const plan = planRetract(ROOT, { ids: opts.ids });
  for (const p of plan.problems) console.error(`FAIL ${p.id}: ${p.msg}`);
  if (plan.retract.length === 0) {
    console.log("retract: nothing to retract (no active claim matched).");
    process.exit(plan.problems.length ? 1 : 0);
  }
  if (!opts.apply) {
    console.log(`retract (dry-run): would tombstone ${plan.retract.length} active claim(s):`);
    for (const r of plan.retract) console.log(`  ${r.claim.id} (${r.claim.confidence}, ${r.claim.classification}) -> ${r.target}`);
    console.log(`  reason: ${opts.reason}`);
    console.log("\nRe-run with --apply to retract (audited; kept in history — reversible by capturing a fresh claim).");
    process.exit(plan.problems.length ? 1 : 0);
  }
  const { retracted } = withWriterLock(ROOT, () => applyRetract(ROOT, plan, { reason: opts.reason }));
  for (const r of retracted) console.log(`retracted ${r.id} -> ${r.target}`);
  generateAll(ROOT, { check: false });
  console.log(`\nretract: ${retracted.length} claim(s) tombstoned (audited); views regenerated.`);
  process.exit(0);
}

// Privacy-safe queue-item label for console output: id + confidence +
// classification + target ONLY — never the claim VALUE (mirrors ratify dry-run).
function queueLabel(q) {
  return `${q.claim.id} (${q.claim.confidence}, ${q.claim.classification}) -> ${q.target}`;
}

function runRecover(opts) {
  const plan = planRecover(ROOT);
  const findings = plan.findings;
  const repairable = findings.filter((f) => f.severity === "repairable");
  const manual = findings.filter((f) => f.severity === "manual");
  const info = findings.filter((f) => f.severity === "info");

  if (findings.length === 0) {
    console.log("recover: runtime store is consistent — no findings.");
    process.exit(0);
  }
  console.log(`recover: ${findings.length} finding(s) — ${repairable.length} auto-repairable, ${manual.length} need a human, ${info.length} info.`);
  console.log("");
  for (const f of repairable) console.log(`  [repairable] ${f.type} ${f.obs_id || f.claim_id || ""}\n      ${f.detail}\n      fix: ${f.repair}`);
  for (const f of manual) console.log(`  [MANUAL]     ${f.type} ${f.obs_id || f.claim_id || ""}\n      ${f.detail}`);
  if (info.length) {
    if (opts.verbose) for (const f of info) console.log(`  [info]       ${f.type} ${f.claim_id || f.obs_id || ""}: ${f.detail}`);
    else console.log(`  [info]       ${info.length} canon claim(s) with no ratifying ledger record (direct captures). Use --verbose to list.`);
  }
  console.log("");

  if (!opts.apply) {
    if (repairable.length) console.log("Re-run with --apply to perform the auto-repairs (append-only ledger reconciliation + stale/duplicate queue cleanup). Manual/info findings are never auto-changed.");
    process.exit(manual.length ? 1 : 0);
  }
  if (repairable.length === 0) {
    console.log("Nothing auto-repairable.");
    process.exit(manual.length ? 1 : 0);
  }
  // Re-plan INSIDE the lock so we act on the current state, not the stale view.
  const { applied } = withWriterLock(ROOT, () => applyRecover(ROOT, planRecover(ROOT)));
  console.log(`recover: applied ${applied.length} repair(s).`);
  if (manual.length) console.log(`${manual.length} finding(s) still need a human (see above).`);
  process.exit(manual.length ? 1 : 0);
}

function runSchema(opts) {
  const declared = readSchemaVersion(ROOT);
  console.log(`schema: engine v${RUNTIME_SCHEMA_VERSION}; store declares v${declared} (${schemaVersionPath(ROOT).replace(ROOT + path.sep, "")}).`);
  if (declared > RUNTIME_SCHEMA_VERSION) {
    console.error(`This store was written by a NEWER engine (v${declared}). Upgrade tools/runner.mjs — writes are refused until then.`);
    process.exit(1);
  }
  if (declared === RUNTIME_SCHEMA_VERSION) {
    console.log("Store is up to date.");
    process.exit(0);
  }
  console.log(`Store is behind by ${RUNTIME_SCHEMA_VERSION - declared} version(s). It auto-migrates on the next write, or migrate now with --apply.`);
  if (opts.apply) {
    const res = withWriterLock(ROOT, () => ensureSchema(ROOT));
    console.log(res.migrated ? `Migrated v${res.from} -> v${res.to}.` : "Nothing to migrate.");
  }
  process.exit(0);
}

function runDeadLetter(opts) {
  // Dead-letter records live PRIVATE-only. Print source/line + problem TYPE
  // messages (safe) but NEVER the raw candidate text (may hold the secret).
  const records = readJsonl(runtimePaths(ROOT, true).deadLetter)
    .concat(readJsonl(runtimePaths(ROOT, false).deadLetter));
  if (records.length === 0) {
    console.log("dead-letter: quarantine is empty — no failed candidates set aside.");
    process.exit(0);
  }
  console.log(`dead-letter: ${records.length} quarantined candidate(s). Fix the source line and re-sync to reprocess (raw text withheld — it may contain sensitive data).\n`);
  for (const r of records) {
    console.log(`  ${r.source_file}:${r.line}  [${r.dl_key}]  quarantined ${r.quarantined_at}`);
    for (const p of r.problems || []) console.log(`      - ${p}`);
  }
  process.exit(0);
}

function runTriage(opts) {
  const buckets = triageQueue(ROOT, {});
  const total = TRIAGE_BUCKETS.reduce((n, b) => n + buckets[b].length, 0);
  if (total === 0) {
    console.log("triage: ratification queue is empty — nothing pending.");
    process.exit(0);
  }
  console.log(`triage: ${total} pending claim(s) in the ratification queue.\n`);
  const legend = {
    "privacy-hold": "PRIVACY-HOLD (restricted/sensitive — you decide; never automated)",
    "needs-clarification": "NEEDS CLARIFICATION (unresolved — a human must clarify)",
    "contradiction": "CONTRADICTION — would conflict with canon; your attention needed",
    "ready": "READY (clean; no conflict; settled confidence)",
  };
  for (const b of TRIAGE_BUCKETS) {
    const items = buckets[b];
    console.log(`## ${legend[b]} — ${items.length}`);
    for (const q of items) console.log(`  - ${queueLabel(q)}`);
    console.log("");
  }
  process.exit(0);
}

function policyFromOpts(opts) {
  const policy = { ...DEFAULT_RATIFY_POLICY };
  if (opts.autoReady) policy.autoRatifyReady = true;
  if (opts.ceiling) policy.classificationCeiling = opts.ceiling;
  if (opts.ratio != null && Number.isFinite(opts.ratio)) policy.decisiveSourceRatio = opts.ratio;
  return policy;
}

function runAutoRatify(opts) {
  const policy = policyFromOpts(opts);
  const plan = planAutoRatify(ROOT, { policy });
  const total = plan.autoRatify.length + plan.resolvable.length + plan.surfaced.length;
  if (total === 0) {
    console.log("auto-ratify: ratification queue is empty — nothing pending.");
    process.exit(0);
  }
  console.log(`auto-ratify: policy autoRatifyReady=${policy.autoRatifyReady}, ceiling=${policy.classificationCeiling}, ratio=${policy.decisiveSourceRatio}:1`);
  console.log(`  ${plan.autoRatify.length} auto-ratify · ${plan.resolvable.length} evidence-decisive (surfaced) · ${plan.surfaced.length} surfaced for human\n`);

  if (plan.resolvable.length) {
    console.log("Evidence-decisive contradictions (ADVISORY — confirm with `ratify --id`; not auto-written):");
    for (const r of plan.resolvable) console.log(`  - ${queueLabel(r.entry)}  [${r.decision.reason}]`);
    console.log("");
  }
  if (plan.surfaced.length) {
    console.log("Surfaced for human ratification:");
    for (const s of plan.surfaced) console.log(`  - [${s.bucket}] ${queueLabel(s.entry)}  (${s.why})`);
    console.log("");
  }

  if (plan.autoRatify.length === 0) {
    console.log("auto-ratify: nothing eligible for auto-promotion under this policy (default is fully manual).");
    writeAuditLog(ROOT, plan.audit);
    process.exit(0);
  }
  if (!opts.apply) {
    console.log(`auto-ratify (dry-run): would auto-promote ${plan.autoRatify.length} ready claim(s):`);
    for (const q of plan.autoRatify) console.log(`  ${queueLabel(q)}`);
    console.log("\nRe-run with --apply to auto-promote (audited; reversible).");
    process.exit(0);
  }
  const res = withWriterLock(ROOT, () => applyAutoRatify(ROOT, plan));
  for (const a of res.appended) console.log(`auto-ratified ${a.id} -> ${a.target}`);
  generateAll(ROOT, { check: false });
  console.log(`\nauto-ratify: ${res.appended.length} claim(s) promoted to canon (audited); views regenerated.`);
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
  else if (cmd === "retract") runRetract(opts);
  else if (cmd === "triage") runTriage(opts);
  else if (cmd === "dead-letter") runDeadLetter(opts);
  else if (cmd === "schema") runSchema(opts);
  else if (cmd === "recover") runRecover(opts);
  else if (cmd === "auto-ratify") runAutoRatify(opts);
  else {
    console.error([
      "Usage:",
      "  runner.mjs project [--entity <id>]... [--adapter gpt|gemini] [-o <file>] [--include-private -o <private/path>]",
      "  runner.mjs import-canonical <envelope.jsonl> --trust [--apply]   # PRIVILEGED: writes straight to canon, bypasses ratification",
      "  runner.mjs sync [--apply] [--watch]                 # observe inbox/observations/ -> ratification queue",
      "  runner.mjs ratify (--all | --id <id>...) [--discard] [--apply]   # promote queued claims into canon",
      "  runner.mjs retract --id <claim_id>... --reason \"<why>\" [--apply]   # tombstone an active canonical claim (Axiom 24; audited, kept in history)",
      "  runner.mjs triage                                   # sort the pending queue into buckets (where you're needed)",
      "  runner.mjs dead-letter                              # list quarantined candidates that failed the sync gates (rt-dead-letter)",
      "  runner.mjs schema [--apply]                         # show runtime schema version; --apply migrates a behind store now (rt-schema-versioning)",
      "  runner.mjs recover [--apply] [--verbose]            # detect (and --apply repair) inconsistent ledger/queue/canon state (rt-recovery-reconcile)",
      "  runner.mjs auto-ratify [--auto-ready] [--ceiling <class>] [--ratio <n>] [--apply]  # delegated ratification (Axiom 18; default: fully manual)",
    ].join("\n"));
    process.exit(1);
  }
}
