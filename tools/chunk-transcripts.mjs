#!/usr/bin/env node
// AxiomCE — chunk-transcripts.mjs
//
// Deterministic splitter that sits between the importer and the extraction step.
// A single ChatGPT conversation can be enormous (the real export has one at
// 1,160 messages / ~210K tokens) — far larger than any model's context window.
// Extraction (a model reading a transcript to propose candidate claims, F1..F10)
// therefore CANNOT ingest such a transcript in one pass. This tool splits each
// transcript into ordered, provenance-preserving CHUNKS that each fit a token
// budget, and emits a flat chunk manifest that the future extraction harness can
// walk as a work queue.
//
//   transcripts/*.json  ->  [chunk-transcripts]  ->  chunks/*.json + chunks/manifest.json
//                                                       |
//                                                       v  (model extraction, F1..F10)
//
// Design guarantees (the whole point — nothing is lost, everything traces back):
//   * Message boundaries are respected. A chunk is a contiguous run of whole
//     messages, in order.
//   * A single message that alone exceeds the budget is split into ordered
//     `part` segments on paragraph/line boundaries — never truncated, never
//     dropped.
//   * Each chunk carries full provenance (conversation_id, source token,
//     chunk_index/chunk_count, and the original message-index range) so any
//     claim extracted from a chunk still resolves to `chatgpt:<id>` (F9).
//   * A configurable `--overlap` of trailing messages is carried into the next
//     chunk as CONTEXT ONLY (`context_prefix`), so a model keeps continuity
//     across a boundary without the extraction step double-counting facts:
//     extraction must treat the first `context_prefix` messages as read-only
//     context and extract claims only from the remainder.
//   * Deterministic. Zero external dependencies. Node stdlib only. No network,
//     no model calls. Token counts are a conservative char-based ESTIMATE
//     (see estimateTokens) because a real tokenizer would add a dependency.
//
// PRIVACY: input transcripts live under the git-excluded private/ tree; output
// defaults alongside them. Chunks MUST NOT land in a tracked directory.
//
// Usage:
//   node tools/chunk-transcripts.mjs [<transcriptsDir|transcript.json>]
//        [-o <outDir>]           # default: <input>/../chunks
//        [--max-tokens N]        # per-chunk content budget (default 8000)
//        [--chars-per-token N]   # estimator divisor (default 4)
//        [--overlap N]           # trailing msgs carried as context (default 1)

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_OVERLAP = 1;

/**
 * Conservative token estimate. We deliberately avoid a real tokenizer (it would
 * add a dependency and the engine is stdlib-only). ~4 chars/token is the widely
 * used rough rule for English; code/JSON runs denser, so treat this as a floor
 * and keep the budget comfortably under the true context window.
 * @param {string} text
 * @param {number} charsPerToken
 * @returns {number}
 */
export function estimateTokens(text, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const n = String(text ?? "").length;
  return Math.ceil(n / Math.max(1, charsPerToken));
}

/**
 * Split a single over-budget message body into ordered segments, each within
 * maxChars, preferring semantic boundaries: paragraphs (\n\n), then lines (\n),
 * then a hard character cut as a last resort. Never drops content.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]} one or more segments (>=1); joining with "" loses nothing
 *   except the exact boundary whitespace collapsed into the split.
 */
export function splitText(text, maxChars) {
  const s = String(text ?? "");
  if (s.length <= maxChars) return [s];

  // Recursive-descent over boundary types.
  const bySep = (str, sep) => {
    const pieces = str.split(sep);
    const segs = [];
    let cur = "";
    for (const piece of pieces) {
      const candidate = cur ? cur + sep + piece : piece;
      if (candidate.length <= maxChars) {
        cur = candidate;
        continue;
      }
      if (cur) segs.push(cur);
      if (piece.length <= maxChars) {
        cur = piece;
      } else {
        // This piece alone is too big — descend to a finer separator.
        cur = "";
        const finer = sep === "\n\n" ? bySep(piece, "\n")
          : sep === "\n" ? hardCut(piece, maxChars)
          : hardCut(piece, maxChars);
        for (const f of finer) segs.push(f);
      }
    }
    if (cur) segs.push(cur);
    return segs;
  };

  const hardCut = (str, max) => {
    const segs = [];
    for (let i = 0; i < str.length; i += max) segs.push(str.slice(i, i + max));
    return segs;
  };

  return bySep(s, "\n\n");
}

/**
 * Expand a transcript's messages into "units", pre-splitting any message whose
 * body alone exceeds maxChars into ordered part-units. Each unit records the
 * index of the original message it came from (orig_index) so provenance and
 * ordering survive the split.
 * @param {{role:string,create_time:(string|null),text:string}[]} messages
 * @param {number} maxChars
 * @returns {{role:string,create_time:(string|null),text:string,orig_index:number,part?:{index:number,count:number}}[]}
 */
export function expandUnits(messages, maxChars) {
  const units = [];
  messages.forEach((m, origIndex) => {
    const text = String(m?.text ?? "");
    if (text.length <= maxChars) {
      units.push({ role: m.role, create_time: m.create_time ?? null, text, orig_index: origIndex });
      return;
    }
    const segs = splitText(text, maxChars);
    segs.forEach((seg, i) => {
      units.push({
        role: m.role,
        create_time: m.create_time ?? null,
        text: seg,
        orig_index: origIndex,
        part: { index: i, count: segs.length },
      });
    });
  });
  return units;
}

/**
 * Greedily pack ordered units into chunks under the token budget. Each chunk
 * (after the first) is prefixed with up to `overlap` trailing units from the
 * previous chunk as read-only context; `context_prefix` records how many.
 * @param {ReturnType<typeof expandUnits>} units
 * @param {{maxTokens:number,charsPerToken:number,overlap:number}} opts
 * @returns {{messages:any[],context_prefix:number,est_tokens:number,char_count:number,orig_start:number,orig_end:number}[]}
 */
export function packChunks(units, opts = {}) {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const overlap = Math.max(0, opts.overlap ?? DEFAULT_OVERLAP);
  if (units.length === 0) return [];

  const tok = (u) => estimateTokens(u.text, charsPerToken);
  const chunks = [];
  let prevTrailing = []; // last `overlap` body units of the previous chunk

  let i = 0;
  while (i < units.length) {
    // Read-only continuity context from the previous chunk. It counts toward
    // the budget: a big trailing message must not silently double a chunk. If
    // even the context + the first body unit would exceed the budget, drop the
    // context for this boundary (continuity is best-effort, the guarantee that
    // a chunk fits the budget is not).
    let context = overlap > 0 ? prevTrailing : [];
    let contextTokens = context.reduce((s, u) => s + tok(u), 0);
    if (context.length && contextTokens + tok(units[i]) > maxTokens) {
      context = [];
      contextTokens = 0;
    }

    const body = [];
    let bodyTokens = 0;
    while (i < units.length) {
      const ut = tok(units[i]);
      // Always take at least one body unit; then add while the WHOLE chunk
      // (context + body) stays within budget.
      if (body.length > 0 && contextTokens + bodyTokens + ut > maxTokens) break;
      body.push(units[i]);
      bodyTokens += ut;
      i++;
    }

    const messages = [...context, ...body];
    chunks.push({
      messages,
      context_prefix: context.length,
      est_tokens: contextTokens + bodyTokens,
      char_count: messages.reduce((s, u) => s + u.text.length, 0),
      orig_start: body[0].orig_index,
      orig_end: body[body.length - 1].orig_index,
    });

    prevTrailing = overlap > 0 ? body.slice(Math.max(0, body.length - overlap)) : [];
  }

  return chunks;
}

/**
 * Split one transcript record into chunk records with full provenance.
 * @param {object} transcript an axiomce.chatgpt-transcript/1 record
 * @param {{maxTokens:number,charsPerToken:number,overlap:number}} opts
 * @returns {object[]} chunk records (>=1 unless the transcript has no messages)
 */
export function chunkTranscript(transcript, opts = {}) {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const maxChars = maxTokens * charsPerToken;

  const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  const units = expandUnits(messages, maxChars);
  const packed = packChunks(units, { maxTokens, charsPerToken, overlap });

  const count = packed.length;
  return packed.map((c, i) => ({
    schema: "axiomce.chatgpt-chunk/1",
    conversation_id: transcript?.conversation_id ?? null,
    source: transcript?.source ?? "chatgpt:unknown",
    title: transcript?.title ?? null,
    created: transcript?.created ?? null,
    updated: transcript?.updated ?? null,
    chunk_index: i,
    chunk_count: count,
    // Original-message index range covered by this chunk's NON-context body.
    message_start: c.orig_start,
    message_end: c.orig_end,
    // How many leading messages are read-only context carried from the prior
    // chunk. Extraction MUST NOT mint new claims from these — they were
    // extractable in the previous chunk. They exist only for continuity.
    context_prefix: c.context_prefix,
    est_tokens: c.est_tokens,
    char_count: c.char_count,
    messages: c.messages,
  }));
}

/** Filesystem-safe base name for a chunk file. */
function chunkFileName(baseName, index, count) {
  const width = String(count - 1).length;
  return `${baseName}.chunk-${String(index).padStart(width, "0")}.json`;
}

/**
 * Chunk every transcript in a directory (or a single transcript file) into an
 * output dir + a flat chunk manifest.
 * @param {string} inputPath transcripts dir OR a single transcript.json
 * @param {object} opts { outDir, maxTokens, charsPerToken, overlap }
 * @returns {{transcripts:number,chunks:number,split:number,oversizeMessages:number,outDir:string,manifestPath:string}}
 */
export function chunkAll(inputPath, opts = {}) {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  const stat = fs.existsSync(inputPath) ? fs.statSync(inputPath) : null;
  if (!stat) throw new Error(`input not found: ${inputPath}`);

  let files;
  let baseInputDir;
  if (stat.isDirectory()) {
    baseInputDir = inputPath;
    files = fs.readdirSync(inputPath)
      .filter((f) => /\.json$/i.test(f) && f !== "manifest.json")
      .sort()
      .map((f) => path.join(inputPath, f));
  } else {
    baseInputDir = path.dirname(inputPath);
    files = [inputPath];
  }

  const outDir = opts.outDir || path.join(path.dirname(baseInputDir), "chunks");
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = [];
  let transcripts = 0;
  let chunkTotal = 0;
  let splitTranscripts = 0;
  let oversizeMessages = 0;

  for (const file of files) {
    let transcript;
    try {
      transcript = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`could not parse transcript ${file}: ${e.message}`);
    }
    if (transcript?.schema && transcript.schema !== "axiomce.chatgpt-transcript/1") {
      continue; // not a transcript — skip quietly (e.g. stray files)
    }
    const chunks = chunkTranscript(transcript, { maxTokens, charsPerToken, overlap });
    if (chunks.length === 0) continue;
    transcripts++;
    if (chunks.length > 1) splitTranscripts++;

    const baseName = path.basename(file).replace(/\.json$/i, "");
    for (const chunk of chunks) {
      if (chunk.messages.some((m) => m.part)) {
        oversizeMessages += chunk.messages.filter((m) => m.part).length;
      }
      const name = chunks.length === 1
        ? `${baseName}.chunk-0.json`
        : chunkFileName(baseName, chunk.chunk_index, chunk.chunk_count);
      fs.writeFileSync(path.join(outDir, name), JSON.stringify(chunk, null, 2) + "\n", { encoding: "utf8" });
      chunkTotal++;
      manifest.push({
        file: name,
        conversation_id: chunk.conversation_id,
        source: chunk.source,
        title: chunk.title,
        chunk_index: chunk.chunk_index,
        chunk_count: chunk.chunk_count,
        message_start: chunk.message_start,
        message_end: chunk.message_end,
        context_prefix: chunk.context_prefix,
        est_tokens: chunk.est_tokens,
      });
    }
  }

  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schema: "axiomce.chatgpt-chunk-manifest/1",
        generator: "tools/chunk-transcripts.mjs",
        chunked_at: new Date().toISOString(),
        source_dir: path.resolve(baseInputDir),
        max_tokens: maxTokens,
        chars_per_token: charsPerToken,
        overlap,
        transcripts,
        chunks: chunkTotal,
        split_transcripts: splitTranscripts,
        oversize_message_parts: oversizeMessages,
        entries: manifest,
      },
      null,
      2
    ) + "\n",
    { encoding: "utf8" }
  );

  return {
    transcripts,
    chunks: chunkTotal,
    split: splitTranscripts,
    oversizeMessages,
    outDir,
    manifestPath,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], outDir: null, maxTokens: null, charsPerToken: null, overlap: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") out.outDir = argv[++i];
    else if (a === "--max-tokens") out.maxTokens = parseInt(argv[++i], 10);
    else if (a === "--chars-per-token") out.charsPerToken = parseInt(argv[++i], 10);
    else if (a === "--overlap") out.overlap = parseInt(argv[++i], 10);
    else out._.push(a);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0] || path.join("private", "inbox", "chatgpt", "transcripts");
  const opts = {};
  if (args.outDir) opts.outDir = args.outDir;
  if (args.maxTokens) opts.maxTokens = args.maxTokens;
  if (args.charsPerToken) opts.charsPerToken = args.charsPerToken;
  if (args.overlap !== null) opts.overlap = args.overlap;

  const r = chunkAll(input, opts);
  process.stderr.write(
    `chunked ${r.transcripts} transcript(s) -> ${r.chunks} chunk(s) ` +
    `(${r.split} split across multiple chunks, ${r.oversizeMessages} oversize message part(s))\n` +
    `out: ${r.outDir}\nmanifest: ${r.manifestPath}\n`
  );
}
