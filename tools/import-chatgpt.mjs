#!/usr/bin/env node
// AxiomCE — import-chatgpt.mjs
//
// Deterministic front-end for the Continuity Engine's ingest path: turn an
// official OpenAI ChatGPT data export (`conversations.json`) into clean,
// chronological, provenance-tagged TRANSCRIPTS that a model can then read to
// propose candidate claims (the extraction step, governed by
// inbox/capture-envelope-spec.md, F1..F10).
//
// This tool NEVER invents claims. The probabilistic / deterministic boundary is
// the whole point of the engine: the model interprets meaning (extraction); the
// runner does the deterministic part (routing, lifecycle, privacy, provenance).
// Emitting claims here would put an unaudited model in the deterministic layer.
// So the pipeline is:
//
//   conversations.json  ->  [import-chatgpt]  ->  private/inbox/chatgpt/transcripts/*.json
//                                                     |
//                                                     v  (model extraction, F1..F10)
//                           inbox/observations/*.jsonl  ->  runner.mjs sync  ->  ratify  ->  canon
//
// PRIVACY: raw ChatGPT conversations are years of personal context and are
// frequently sensitive. Output therefore defaults to a git-excluded path under
// private/ (the same sensitive-ingress boundary the runtime enforces). It MUST
// NOT land in a tracked directory.
//
// Zero external dependencies. Node stdlib only. No network, no model calls.
//
// Usage:
//   node tools/import-chatgpt.mjs <conversations.json | dir-containing-it>
//        [-o <outdir>]            # default: private/inbox/chatgpt
//        [--roles user,assistant] # message roles to keep (default user,assistant)
//        [--since YYYY-MM-DD]      # only conversations updated on/after this date
//        [--until YYYY-MM-DD]      # only conversations updated on/before this date
//        [--limit N]              # cap number of conversations (after date filter)
//        [--include-hidden]       # keep visually-hidden messages (default: drop)
//        [--min-messages N]       # skip conversations with fewer kept msgs (default 1)
//
// The zip from OpenAI must be unzipped first (kept dependency-free on purpose);
// point this tool at the extracted conversations.json.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_OUT = path.join("private", "inbox", "chatgpt");
const DEFAULT_ROLES = ["user", "assistant"];

/** Unix epoch seconds (float|null) -> ISO string, or null. */
export function epochToIso(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return null;
  return new Date(Number(sec) * 1000).toISOString();
}

/** Filesystem-safe slug from a conversation title. */
export function slugify(title, fallback = "untitled") {
  const s = String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || fallback;
}

/**
 * Extract the plain text of a single ChatGPT message node, tolerating the
 * several content shapes the export uses (text parts, code `text`, multimodal
 * parts with embedded objects). Non-text parts (image pointers, etc.) are
 * dropped rather than guessed at.
 * @param {object} message a mapping[node].message
 * @returns {string} trimmed text ("" if none)
 */
export function messageText(message) {
  const c = message?.content;
  if (!c) return "";
  if (Array.isArray(c.parts)) {
    return c.parts
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof c.text === "string") return c.text.trim();
  return "";
}

/**
 * Reconstruct the ACTIVE linear thread of a conversation. The export stores a
 * DAG (edited messages fork branches); the canonical thread is the path from
 * `current_node` up to the root. Walk parents from current_node, then reverse.
 * @param {object} conv one conversation object
 * @param {{ roles?:string[], includeHidden?:boolean }} opts
 * @returns {{ role:string, create_time:(string|null), text:string }[]}
 */
export function linearize(conv, opts = {}) {
  const roles = opts.roles || DEFAULT_ROLES;
  const includeHidden = !!opts.includeHidden;
  const mapping = conv?.mapping || {};

  let nodeId = conv?.current_node;
  if (!nodeId || !mapping[nodeId]) {
    // Fallback: pick a leaf (no children), else any node.
    nodeId =
      Object.keys(mapping).find((id) => (mapping[id]?.children || []).length === 0) ||
      Object.keys(mapping)[0] ||
      null;
  }

  const chain = [];
  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  chain.reverse();

  const out = [];
  for (const node of chain) {
    const m = node?.message;
    if (!m || !m.author) continue;
    const role = m.author.role;
    if (!roles.includes(role)) continue;
    if (!includeHidden && m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
    const text = messageText(m);
    if (!text) continue;
    out.push({ role, create_time: epochToIso(m.create_time), text });
  }
  return out;
}

/**
 * Normalize one conversation into a transcript record with provenance.
 * @param {object} conv
 * @param {object} opts passed to linearize
 * @returns {object} transcript record
 */
export function toTranscript(conv, opts = {}) {
  const id = conv?.conversation_id || conv?.id || null;
  const messages = linearize(conv, opts);
  return {
    schema: "axiomce.chatgpt-transcript/1",
    conversation_id: id,
    title: conv?.title ?? null,
    created: epochToIso(conv?.create_time),
    updated: epochToIso(conv?.update_time),
    // Stable provenance token for the `source` field of any claim extracted
    // from this conversation (see capture-envelope-spec F9).
    source: id ? `chatgpt:${id}` : "chatgpt:unknown",
    message_count: messages.length,
    user_message_count: messages.filter((m) => m.role === "user").length,
    messages,
  };
}

/** Parse the export payload (path to conversations.json or a dir) into an array. */
export function loadExport(inputPath) {
  let file = inputPath;
  const stat = fs.existsSync(inputPath) ? fs.statSync(inputPath) : null;
  if (!stat) throw new Error(`input not found: ${inputPath}`);
  if (stat.isDirectory()) {
    file = path.join(inputPath, "conversations.json");
    if (!fs.existsSync(file)) {
      throw new Error(`no conversations.json in ${inputPath} (unzip the OpenAI export first, then point here)`);
    }
  }
  if (/\.zip$/i.test(file)) {
    throw new Error(`got a .zip — unzip it first (this tool is zero-dependency): expand it, then pass the conversations.json inside`);
  }
  const raw = fs.readFileSync(file, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`could not parse ${file} as JSON: ${e.message}`);
  }
  // OpenAI ships a top-level array of conversations.
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.conversations)) return data.conversations;
  throw new Error(`unexpected export shape in ${file}: expected an array of conversations`);
}

/**
 * Import an export into transcript files + a triage manifest.
 * @param {string} inputPath conversations.json (or a directory containing it)
 * @param {object} opts { outDir, roles, since, until, limit, includeHidden, minMessages }
 * @returns {{ written:number, skipped:number, outDir:string, manifestPath:string, transcriptsDir:string }}
 */
export function importExport(inputPath, opts = {}) {
  const outDir = opts.outDir || DEFAULT_OUT;
  const roles = opts.roles || DEFAULT_ROLES;
  const minMessages = opts.minMessages ?? 1;
  const includeHidden = !!opts.includeHidden;
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const untilMs = opts.until ? Date.parse(opts.until) : null;

  const convs = loadExport(inputPath);
  const transcriptsDir = path.join(outDir, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const manifest = [];
  let written = 0;
  let skipped = 0;
  const usedNames = new Set();

  // Newest-first so triage surfaces recent context first.
  const ordered = [...convs].sort((a, b) => (Number(b?.update_time) || 0) - (Number(a?.update_time) || 0));

  for (const conv of ordered) {
    if (opts.limit && written >= opts.limit) break;

    const updatedMs = Number(conv?.update_time) ? Number(conv.update_time) * 1000 : null;
    if (sinceMs && (updatedMs === null || updatedMs < sinceMs)) { skipped++; continue; }
    if (untilMs && (updatedMs === null || updatedMs > untilMs)) { skipped++; continue; }

    const t = toTranscript(conv, { roles, includeHidden });
    if (t.message_count < minMessages) { skipped++; continue; }

    const shortId = (t.conversation_id || "noid").replace(/[^\w-]/g, "").slice(0, 8) || "noid";
    let name = `${slugify(t.title)}-${shortId}`;
    while (usedNames.has(name)) name = `${name}-x`;
    usedNames.add(name);
    const rel = path.join("transcripts", `${name}.json`);

    fs.writeFileSync(path.join(outDir, rel), JSON.stringify(t, null, 2) + "\n", { encoding: "utf8" });
    written++;
    manifest.push({
      file: rel.replace(/\\/g, "/"),
      conversation_id: t.conversation_id,
      title: t.title,
      created: t.created,
      updated: t.updated,
      source: t.source,
      messages: t.message_count,
      user_messages: t.user_message_count,
    });
  }

  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schema: "axiomce.chatgpt-manifest/1",
        generator: "tools/import-chatgpt.mjs",
        imported_at: new Date().toISOString(),
        source_file: path.resolve(inputPath),
        roles,
        total_conversations: convs.length,
        written,
        skipped,
        conversations: manifest,
      },
      null,
      2
    ) + "\n",
    { encoding: "utf8" }
  );

  return { written, skipped, outDir, manifestPath, transcriptsDir };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], outDir: null, roles: null, since: null, until: null,
                limit: null, includeHidden: false, minMessages: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") out.outDir = argv[++i];
    else if (a === "--roles") out.roles = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--since") out.since = argv[++i];
    else if (a === "--until") out.until = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--min-messages") out.minMessages = parseInt(argv[++i], 10);
    else if (a === "--include-hidden") out.includeHidden = true;
    else out._.push(a);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const input = opts._[0];
  if (!input) {
    console.error([
      "Usage:",
      "  node tools/import-chatgpt.mjs <conversations.json | dir> [-o <outdir>]",
      "     [--roles user,assistant] [--since YYYY-MM-DD] [--until YYYY-MM-DD]",
      "     [--limit N] [--min-messages N] [--include-hidden]",
      "",
      "Output defaults to private/inbox/chatgpt/ (git-excluded — raw conversations",
      "are sensitive). Produces transcripts/*.json + manifest.json for triage.",
      "Next: a model reads transcripts and emits observation envelopes per",
      "inbox/capture-envelope-spec.md, then: node tools/runner.mjs sync --apply.",
    ].join("\n"));
    process.exit(1);
  }
  try {
    const res = importExport(input, {
      outDir: opts.outDir,
      roles: opts.roles,
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      includeHidden: opts.includeHidden,
      minMessages: opts.minMessages,
    });
    const destWarn = /(^|[\\/])private[\\/]/.test(res.outDir) ? "" :
      "  WARNING: output is NOT under private/ — raw conversations may be sensitive.\n";
    console.error(
      `import-chatgpt: wrote ${res.written} transcript(s), skipped ${res.skipped}.\n` +
      destWarn +
      `  transcripts: ${path.relative(".", res.transcriptsDir)}\n` +
      `  manifest:    ${path.relative(".", res.manifestPath)}\n` +
      `Next: triage the manifest, extract candidate claims per the envelope spec, then sync.`
    );
    process.exit(0);
  } catch (e) {
    console.error(`import-chatgpt: ${e.message}`);
    process.exit(1);
  }
}
