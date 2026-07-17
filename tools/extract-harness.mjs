#!/usr/bin/env node
// AxiomCE — extract-harness.mjs
//
// The deterministic orchestrator for the extraction step: it walks the chunk
// manifest as a resumable work queue, and it validates + files the envelopes a
// model produces. It NEVER calls a model itself — the probabilistic/deterministic
// boundary is the whole point of the engine (see import-chatgpt.mjs). Meaning is
// interpreted by the model (the middle step); the harness only does the
// deterministic halves around it:
//
//   chunks/manifest.json
//        |
//        v  plan            -> extraction/tasks.jsonl (+ state.json)   [deterministic]
//        v  [model reads a chunk, emits an F1..F10 envelope]           [PROBABILISTIC]
//        v  ingest          -> validated observations + batch manifest [deterministic]
//        v  (later, privacy-routed) runner.mjs sync -> ratify -> canon
//
// The extraction step (the middle) is run by an agent or any model you choose:
// for each pending task, read the chunk file, render the prompt with
// `buildExtractionPrompt(chunk)`, get the model's JSONL envelope, and write it to
// extraction/results/<task>.jsonl. Then `ingest` validates every line.
//
// MODEL-AGNOSTIC BY DESIGN. Fidelity is anchored by the capture-envelope spec
// (F1..F10), not by any one model. Which model performed an extraction is
// recorded at the BATCH level (the claim schema is fixed and cannot carry an
// `extractor` field), leaving a clean seam for a future cross-model ensemble /
// divergence diff over two result sets.
//
// Deterministic validation guards enforced at ingest (belt-and-suspenders ahead
// of the runner's own gates):
//   * PROVENANCE (F9): every candidate's `source` MUST equal the chunk's source
//     token (chatgpt:<id>) — a model cannot mis-attribute a claim.
//   * CONFIDENCE CEILING (F5/F9, SOURCE_POLICY): an AI-conversation import can
//     never be `confirmed`; such lines are rejected.
//   * ENVELOPE SHAPE: required fields present, enums valid, id_domain present
//     when id is omitted, no unknown fields.
//
// PRIVACY: results and observations are raw personal candidate claims. Output
// defaults to the git-excluded private/ tree. It MUST NOT land in a tracked dir.
// Wiring these observations into `runner.mjs sync` is a separate, privacy-routed
// step (sync reads the tracked inbox/observations/ today).
//
// Zero external dependencies. Node stdlib only. No network, no model calls.
//
// Usage:
//   node tools/extract-harness.mjs plan   [<chunksDir|chunks/manifest.json>] [-o <workDir>]
//        [--limit N] [--only <conversation_id>] [--min-tokens N]
//   node tools/extract-harness.mjs ingest [<workDir>] [--extractor <model-id>]
//   node tools/extract-harness.mjs status [<workDir>]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { CONFIDENCE_LEVELS } from "./validate-claims.mjs";
import { ALLOWED_CLASSIFICATIONS } from "./validate.mjs";

const DEFAULT_CHUNKS = path.join("private", "inbox", "chatgpt", "chunks");
const DEFAULT_WORKDIR = path.join("private", "inbox", "chatgpt", "extraction");
const SPEC_VERSION = "capture-envelope-spec/0.1 (F1..F10)";

// Envelope-candidate field rules (a SUPERSET-minus of the full claim schema:
// id + asserted_at are optional here because the runner mints them, and
// id_domain is an allowed capture-only token). Kept local so the harness does
// not depend on runner internals.
const ENV_REQUIRED = ["entity", "predicate", "value", "confidence", "classification", "valid_from", "source"];
const ENV_ALLOWED = new Set([
  ...ENV_REQUIRED,
  "id", "id_domain", "asserted_at", "valid_to", "supersedes", "note",
]);
const ENTITY_RE = /^[a-z]+:[a-z0-9][a-z0-9-]*$/;
const PRED_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^clm-[a-z0-9]+-\d{4,}$/;

// ---------------------------------------------------------------------------
// Prompt rendering (the instruction handed to the model for one chunk).
// ---------------------------------------------------------------------------

/**
 * Render a complete, self-contained extraction instruction for one chunk. The
 * returned string embeds the normative F1..F10 rules, the output contract, the
 * exact `source` token to stamp, the read-only context handling, and the chunk
 * messages. A model (or agent) turns this into an F1..F10 envelope (JSONL).
 * @param {object} chunk an axiomce.chatgpt-chunk/1 record
 * @param {{today?:string}} opts
 * @returns {string}
 */
export function buildExtractionPrompt(chunk, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const source = chunk?.source || "chatgpt:unknown";
  const ctx = chunk?.context_prefix || 0;
  const messages = Array.isArray(chunk?.messages) ? chunk.messages : [];

  const body = messages
    .map((m, i) => {
      const tag = i < ctx ? `${m.role} [READ-ONLY CONTEXT]` : m.role;
      const part = m.part ? ` (part ${m.part.index + 1}/${m.part.count})` : "";
      const when = m.create_time ? ` @ ${m.create_time}` : "";
      return `--- ${tag}${part}${when} ---\n${m.text}`;
    })
    .join("\n\n");

  return `You are extracting durable, separately-queryable FACTS from an excerpt of
a personal ChatGPT conversation, into a candidate-claims envelope. You are the
only party that sees the conversation; the downstream engine is deterministic and
cannot repair meaning you get wrong. Follow these rules exactly.

OUTPUT: UTF-8 JSONL — one JSON object (one candidate claim) per line. No prose,
no code fences. Blank lines and lines beginning "//" are ignored. Emit NOTHING if
the excerpt contains no durable fact worth recording.

EACH candidate MUST carry: entity, predicate, value, confidence, classification,
valid_from, source. Omit id and asserted_at (the runner mints them) but then
include id_domain (a short token, e.g. "cg"). MAY carry: valid_to, supersedes, note.
  * entity  : "<type>:<slug>" (lowercase, e.g. person:jane-doe, project:axiom).
  * predicate: kebab-case (e.g. drives-vehicle, employer, decided-to).
  * value   : a string. ONE fact per claim.
  * confidence: one of ${CONFIDENCE_LEVELS.join(", ")}.
  * classification: one of ${ALLOWED_CLASSIFICATIONS.join(", ")}.
  * valid_from: YYYY-MM-DD, the date the fact became true IN THE WORLD (NOT today,
    unless that is genuinely when it became true). Use ${today} only if the excerpt
    gives no better date.
  * source  : MUST be exactly "${source}". Do not invent another source.

FIDELITY RULES (binding):
  F1 State, not aspiration. Record what is true NOW. A plan/pilot/intention is
     NOT the established fact. Real change -> supersedes (evolution) or valid_to.
  F2 Preserve negation. Something ruled out is a fact: record it as an explicit
     "...-ruled-out" claim; never emit it as a positive.
  F3 Atomic decomposition. Distinct facts get distinct predicates; never fuse.
  F4 Preserve contradiction; do not adjudicate. Conflicting values -> emit both
     faithfully (let the engine surface it). Coexisting-under-conditions -> distinct
     predicates + note. Unreconciled -> add an "unresolved" claim naming the question.
  F5 Confidence discipline. Match the speaker's actual stance. Hedges ("pretty
     sure", "might", "~60%") are NOT confirmed. A first-person assertion is
     user-stated. A genuine unknown is unresolved.
  F6 Classification routing. Sensitive personal data (pay, health, custody,
     bankruptcy figures, account numbers) MUST be classified restricted (or
     sensitive), never personal/public.
  F7 Never-store. Credentials, secrets, API keys, passwords, full card/account
     numbers MUST NOT appear in any claim. Omit them entirely.
  F8 Independent time. valid_from is when-true-in-world; do not collapse it with
     when-recorded. Use valid_to for expiry, supersedes for resolved evolution.
  F9 Provenance + ceiling. This is an AI-conversation import: confidence CEILINGS
     at user-stated. NEVER emit "confirmed" — it requires an independent source.
  F10 Nuance survives in note. Any caveat/condition/scope the compact value cannot
     hold MUST go in note.

CONTEXT HANDLING: messages tagged [READ-ONLY CONTEXT] (the first ${ctx}) are carried
from the previous chunk for continuity ONLY. Do NOT mint claims whose sole basis is
a context message — they were extractable in the previous chunk. Use them only to
disambiguate the non-context messages below.

CONVERSATION EXCERPT (source ${source}, chunk ${chunk?.chunk_index}/${(chunk?.chunk_count || 1) - 1}):

${body}
`;
}

// ---------------------------------------------------------------------------
// Envelope validation (ingest side).
// ---------------------------------------------------------------------------

/**
 * Validate one parsed envelope candidate against the capture contract, plus the
 * two provenance/ceiling guards. Returns a list of problems ([] == valid).
 * @param {object} c parsed candidate
 * @param {{expectedSource:string}} ctx
 * @returns {string[]}
 */
export function validateEnvelopeCandidate(c, ctx = {}) {
  const p = [];
  if (typeof c !== "object" || c === null || Array.isArray(c)) return ["not a JSON object"];

  for (const k of ENV_REQUIRED) {
    if (!(k in c) || c[k] === null || c[k] === undefined || c[k] === "") p.push(`missing required field: ${k}`);
  }
  for (const k of Object.keys(c)) {
    if (!ENV_ALLOWED.has(k)) p.push(`unknown field: ${k}`);
  }
  if (!c.id && (!c.id_domain || typeof c.id_domain !== "string")) {
    p.push("missing id and id_domain (need one to mint an id)");
  }
  if (c.id !== undefined && c.id !== null && !ID_RE.test(String(c.id))) {
    p.push(`invalid id format: "${c.id}"`);
  }
  if (c.entity && !ENTITY_RE.test(String(c.entity))) p.push(`invalid entity: "${c.entity}"`);
  if (c.predicate && !PRED_RE.test(String(c.predicate))) p.push(`invalid predicate (kebab-case): "${c.predicate}"`);
  if (c.value !== undefined && typeof c.value !== "string") p.push("value must be a string");
  if (c.confidence && !CONFIDENCE_LEVELS.includes(c.confidence)) {
    p.push(`invalid confidence "${c.confidence}"`);
  }
  if (c.classification && !ALLOWED_CLASSIFICATIONS.includes(c.classification)) {
    p.push(`invalid classification "${c.classification}"`);
  }
  if (c.valid_from && !DATE_RE.test(String(c.valid_from))) p.push(`invalid valid_from "${c.valid_from}"`);
  if (c.valid_to && !DATE_RE.test(String(c.valid_to))) p.push(`invalid valid_to "${c.valid_to}"`);
  if (c.supersedes && !ID_RE.test(String(c.supersedes))) p.push(`invalid supersedes id "${c.supersedes}"`);

  // Guard 1 — PROVENANCE (F9): source must match this chunk's token exactly.
  if (ctx.expectedSource && c.source && c.source !== ctx.expectedSource) {
    p.push(`source "${c.source}" does not match chunk source "${ctx.expectedSource}" (F9 provenance)`);
  }
  // Guard 2 — CONFIDENCE CEILING (F5/F9): an AI import can never be confirmed.
  if (c.confidence === "confirmed") {
    p.push("confidence 'confirmed' is not allowed for an AI-conversation import (ceilings at user-stated — F9)");
  }
  return p;
}

/** Semantic idempotency key for a candidate (entity|predicate|value|valid_from). */
function candidateHash(c) {
  const key = `${c.entity}\u0000${c.predicate}\u0000${c.value}\u0000${c.valid_from}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// plan / ingest / status
// ---------------------------------------------------------------------------

function loadChunkManifest(input) {
  const stat = fs.existsSync(input) ? fs.statSync(input) : null;
  if (!stat) throw new Error(`chunks input not found: ${input}`);
  const manifestPath = stat.isDirectory() ? path.join(input, "manifest.json") : input;
  if (!fs.existsSync(manifestPath)) throw new Error(`no chunk manifest at ${manifestPath} (run chunk-transcripts first)`);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (m.schema !== "axiomce.chatgpt-chunk-manifest/1") throw new Error(`unexpected manifest schema: ${m.schema}`);
  return { manifest: m, dir: path.dirname(path.resolve(manifestPath)) };
}

/**
 * Build (or refresh) the resumable extraction work queue from a chunk manifest.
 * Existing task statuses are preserved so `plan` can be re-run safely.
 * @returns {{workDir:string, tasksPath:string, planned:number, total:number}}
 */
export function planExtraction(chunksInput, opts = {}) {
  const { manifest, dir: chunksDir } = loadChunkManifest(chunksInput);
  const workDir = opts.workDir || DEFAULT_WORKDIR;
  fs.mkdirSync(path.join(workDir, "results"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "observations"), { recursive: true });

  const tasksPath = path.join(workDir, "tasks.jsonl");
  const existing = new Map();
  if (fs.existsSync(tasksPath)) {
    for (const line of fs.readFileSync(tasksPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const t = JSON.parse(line);
      existing.set(t.task, t);
    }
  }

  let entries = manifest.entries;
  if (opts.only) entries = entries.filter((e) => e.conversation_id === opts.only);
  if (opts.minTokens) entries = entries.filter((e) => (e.est_tokens || 0) >= opts.minTokens);
  if (opts.limit) entries = entries.slice(0, opts.limit);

  const tasks = [];
  for (const e of entries) {
    const task = e.file.replace(/\.json$/i, "");
    const prev = existing.get(task);
    tasks.push({
      task,
      chunk_file: path.join(chunksDir, e.file),
      conversation_id: e.conversation_id,
      source: e.source,
      chunk_index: e.chunk_index,
      chunk_count: e.chunk_count,
      est_tokens: e.est_tokens,
      status: prev?.status || "pending", // pending -> extracted -> ingested
    });
  }

  fs.writeFileSync(tasksPath, tasks.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");
  fs.writeFileSync(
    path.join(workDir, "state.json"),
    JSON.stringify(
      { schema: "axiomce.extraction-state/1", spec_version: SPEC_VERSION,
        chunks_dir: chunksDir, planned: tasks.length, planned_at: new Date().toISOString() },
      null, 2
    ) + "\n",
    "utf8"
  );
  return { workDir, tasksPath, planned: tasks.length, total: manifest.entries.length };
}

/** Read the task queue (or throw if plan hasn't run). */
function loadTasks(workDir) {
  const tasksPath = path.join(workDir, "tasks.jsonl");
  if (!fs.existsSync(tasksPath)) throw new Error(`no tasks.jsonl in ${workDir} — run 'plan' first`);
  const tasks = [];
  for (const line of fs.readFileSync(tasksPath, "utf8").split("\n")) {
    if (line.trim()) tasks.push(JSON.parse(line));
  }
  return { tasksPath, tasks };
}

/**
 * Validate + file every result envelope that an extractor has produced. Reads
 * extraction/results/<task>.jsonl, validates each line (provenance + ceiling +
 * shape), dedupes within the batch, writes runner-ready observations plus a
 * batch manifest recording WHICH extractor produced them.
 * @returns {{workDir:string, ingested_tasks:number, valid:number, rejected:number, duplicates:number, observationsFile:string, rejectReasons:object}}
 */
export function ingestEnvelopes(workDir = DEFAULT_WORKDIR, opts = {}) {
  const { tasksPath, tasks } = loadTasks(workDir);
  const resultsDir = path.join(workDir, "results");
  const obsDir = path.join(workDir, "observations");
  fs.mkdirSync(obsDir, { recursive: true });

  const valid = [];
  const seen = new Set();
  let rejected = 0;
  let duplicates = 0;
  let ingestedTasks = 0;
  const rejectReasons = {};
  const bump = (why) => { const k = why.replace(/"[^"]*"/g, '"…"'); rejectReasons[k] = (rejectReasons[k] || 0) + 1; };

  for (const t of tasks) {
    const rf = path.join(resultsDir, `${t.task}.jsonl`);
    if (!fs.existsSync(rf)) continue; // not extracted yet
    ingestedTasks++;
    const lines = fs.readFileSync(rf, "utf8").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("//")) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { rejected++; bump("malformed JSON line"); continue; }
      const problems = validateEnvelopeCandidate(obj, { expectedSource: t.source });
      if (problems.length) { rejected++; for (const p of problems) bump(p); continue; }
      const h = candidateHash(obj);
      if (seen.has(h)) { duplicates++; continue; }
      seen.add(h);
      valid.push(obj);
    }
    t.status = "ingested";
  }

  const batch = `chatgpt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const observationsFile = path.join(obsDir, `${batch}.jsonl`);
  fs.writeFileSync(observationsFile, valid.map((c) => JSON.stringify(c)).join("\n") + (valid.length ? "\n" : ""), "utf8");
  fs.writeFileSync(
    path.join(obsDir, `${batch}.manifest.json`),
    JSON.stringify(
      { schema: "axiomce.extraction-batch/1", generator: "tools/extract-harness.mjs",
        spec_version: SPEC_VERSION, extractor: opts.extractor || "unspecified",
        ingested_at: new Date().toISOString(), observations_file: `${batch}.jsonl`,
        ingested_tasks: ingestedTasks, valid: valid.length, rejected, duplicates,
        reject_reasons: rejectReasons },
      null, 2
    ) + "\n",
    "utf8"
  );

  // Persist updated task statuses.
  fs.writeFileSync(tasksPath, tasks.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

  return { workDir, ingested_tasks: ingestedTasks, valid: valid.length, rejected, duplicates, observationsFile, rejectReasons };
}

/** Summarize queue status (counts only). */
export function status(workDir = DEFAULT_WORKDIR) {
  const { tasks } = loadTasks(workDir);
  const by = { pending: 0, extracted: 0, ingested: 0 };
  const resultsDir = path.join(workDir, "results");
  for (const t of tasks) {
    let s = t.status || "pending";
    if (s === "pending" && fs.existsSync(path.join(resultsDir, `${t.task}.jsonl`))) s = "extracted";
    by[s] = (by[s] || 0) + 1;
  }
  return { total: tasks.length, ...by };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], workDir: null, limit: null, only: null, minTokens: null, extractor: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") out.workDir = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--only") out.only = argv[++i];
    else if (a === "--min-tokens") out.minTokens = parseInt(argv[++i], 10);
    else if (a === "--extractor") out.extractor = argv[++i];
    else out._.push(a);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const opts = {};
  if (args.workDir) opts.workDir = args.workDir;
  if (args.limit) opts.limit = args.limit;
  if (args.only) opts.only = args.only;
  if (args.minTokens) opts.minTokens = args.minTokens;
  if (args.extractor) opts.extractor = args.extractor;

  try {
    if (cmd === "plan") {
      const input = args._[0] || DEFAULT_CHUNKS;
      const r = planExtraction(input, opts);
      process.stderr.write(`planned ${r.planned} task(s) (of ${r.total} chunk(s)) -> ${r.tasksPath}\n`);
    } else if (cmd === "ingest") {
      const wd = args._[0] || opts.workDir || DEFAULT_WORKDIR;
      const r = ingestEnvelopes(wd, opts);
      process.stderr.write(
        `ingested ${r.ingested_tasks} task result(s): ${r.valid} valid, ${r.rejected} rejected, ${r.duplicates} duplicate(s)\n` +
        `observations: ${r.observationsFile}\n`
      );
      if (r.rejected) process.stderr.write(`reject reasons: ${JSON.stringify(r.rejectReasons)}\n`);
    } else if (cmd === "status") {
      const wd = args._[0] || opts.workDir || DEFAULT_WORKDIR;
      const s = status(wd);
      process.stderr.write(`tasks: ${s.total} — pending ${s.pending}, extracted ${s.extracted}, ingested ${s.ingested}\n`);
    } else {
      process.stderr.write("usage: extract-harness.mjs <plan|ingest|status> [args]\n");
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}
