// Tests for tools/chunk-transcripts.mjs — deterministic transcript chunker.
// Node's built-in runner only. No network, no model, no external deps.
// Run with:  node --test "tools/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  estimateTokens,
  splitText,
  expandUnits,
  packChunks,
  chunkTranscript,
  chunkAll,
} from "./chunk-transcripts.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-chunk-"));
}

function msg(role, text, i) {
  return { role, create_time: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`, text };
}

function transcript(messages, extra = {}) {
  return {
    schema: "axiomce.chatgpt-transcript/1",
    conversation_id: extra.id ?? "conv-abc",
    title: extra.title ?? "A Title",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    source: `chatgpt:${extra.id ?? "conv-abc"}`,
    message_count: messages.length,
    user_message_count: messages.filter((m) => m.role === "user").length,
    messages,
  };
}

// -- estimateTokens ---------------------------------------------------------

test("estimateTokens: ~chars/4, ceil, handles empty", () => {
  assert.equal(estimateTokens("", 4), 0);
  assert.equal(estimateTokens("abcd", 4), 1);
  assert.equal(estimateTokens("abcde", 4), 2); // ceil(5/4)
  assert.equal(estimateTokens(null, 4), 0);
});

// -- splitText --------------------------------------------------------------

test("splitText: returns whole string when under limit", () => {
  assert.deepEqual(splitText("short", 100), ["short"]);
});

test("splitText: prefers paragraph boundaries, no content lost by length", () => {
  const p = "a".repeat(40);
  const text = `${p}\n\n${p}\n\n${p}`;
  const segs = splitText(text, 50);
  assert.ok(segs.length >= 3);
  for (const s of segs) assert.ok(s.length <= 50, `segment too big: ${s.length}`);
});

test("splitText: hard-cuts a single oversized line as last resort", () => {
  const line = "x".repeat(1000); // no separators at all
  const segs = splitText(line, 100);
  assert.equal(segs.length, 10);
  for (const s of segs) assert.ok(s.length <= 100);
  assert.equal(segs.join(""), line); // nothing lost on a hard cut
});

// -- expandUnits ------------------------------------------------------------

test("expandUnits: small messages pass through with orig_index, no part", () => {
  const units = expandUnits([msg("user", "hi", 0), msg("assistant", "yo", 1)], 100);
  assert.equal(units.length, 2);
  assert.equal(units[0].orig_index, 0);
  assert.equal(units[1].orig_index, 1);
  assert.equal(units[0].part, undefined);
});

test("expandUnits: an oversized message splits into ordered parts sharing orig_index", () => {
  const big = "y".repeat(500);
  const units = expandUnits([msg("user", "small", 0), msg("assistant", big, 1)], 100);
  const parts = units.filter((u) => u.orig_index === 1);
  assert.ok(parts.length > 1);
  parts.forEach((u, i) => {
    assert.equal(u.part.index, i);
    assert.equal(u.part.count, parts.length);
  });
  assert.equal(parts.map((u) => u.text).join(""), big);
});

// -- packChunks -------------------------------------------------------------

test("packChunks: respects the token budget across chunks", () => {
  // each message ~ 25 tokens (100 chars / 4); budget 60 -> 2 messages per chunk
  const units = expandUnits(
    Array.from({ length: 6 }, (_, i) => msg(i % 2 ? "assistant" : "user", "z".repeat(100), i)),
    1000
  );
  const chunks = packChunks(units, { maxTokens: 60, charsPerToken: 4, overlap: 0 });
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    // body-only (no overlap here) est must not exceed budget by more than one message
    assert.ok(c.est_tokens <= 60, `chunk est ${c.est_tokens} over budget`);
  }
});

test("packChunks: overlap carries trailing context and sets context_prefix", () => {
  const units = expandUnits(
    Array.from({ length: 6 }, (_, i) => msg(i % 2 ? "assistant" : "user", "z".repeat(100), i)),
    1000
  );
  const chunks = packChunks(units, { maxTokens: 60, charsPerToken: 4, overlap: 1 });
  assert.ok(chunks.length >= 2);
  // first chunk has no context; later chunks carry exactly 1 context message
  assert.equal(chunks[0].context_prefix, 0);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].context_prefix, 1);
  }
});

test("packChunks: empty input yields no chunks", () => {
  assert.deepEqual(packChunks([], { maxTokens: 60 }), []);
});

test("packChunks: overlap never pushes a chunk over the budget", () => {
  // Large trailing messages that, if carried as uncounted context, would double
  // a chunk. Every chunk's total est must still fit the budget.
  const units = expandUnits(
    Array.from({ length: 8 }, (_, i) => msg(i % 2 ? "assistant" : "user", "z".repeat(220), i)),
    1000
  );
  const chunks = packChunks(units, { maxTokens: 60, charsPerToken: 4, overlap: 1 });
  for (const c of chunks) {
    assert.ok(c.est_tokens <= 60, `chunk est ${c.est_tokens} exceeds budget 60`);
  }
});

// -- chunkTranscript --------------------------------------------------------

test("chunkTranscript: a small transcript becomes exactly one chunk", () => {
  const t = transcript([msg("user", "hi", 0), msg("assistant", "hello", 1)]);
  const chunks = chunkTranscript(t, { maxTokens: 8000 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_index, 0);
  assert.equal(chunks[0].chunk_count, 1);
  assert.equal(chunks[0].context_prefix, 0);
  assert.equal(chunks[0].source, "chatgpt:conv-abc");
});

test("chunkTranscript: a large transcript splits and preserves provenance + order", () => {
  const msgs = Array.from({ length: 40 }, (_, i) =>
    msg(i % 2 ? "assistant" : "user", "w".repeat(400), i)
  );
  const t = transcript(msgs, { id: "big1" });
  const chunks = chunkTranscript(t, { maxTokens: 500, charsPerToken: 4, overlap: 1 });
  assert.ok(chunks.length > 1);
  // chunk_count is consistent and indices are sequential
  chunks.forEach((c, i) => {
    assert.equal(c.chunk_index, i);
    assert.equal(c.chunk_count, chunks.length);
    assert.equal(c.source, "chatgpt:big1");
    assert.ok(c.message_start <= c.message_end);
  });
  // message ranges are monotonically non-decreasing across chunks
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].message_start >= chunks[i - 1].message_start);
  }
});

test("chunkTranscript: no messages -> no chunks", () => {
  const t = transcript([]);
  assert.deepEqual(chunkTranscript(t, { maxTokens: 8000 }), []);
});

// -- chunkAll (filesystem) --------------------------------------------------

test("chunkAll: writes chunk files + a flat manifest over a directory", () => {
  const root = tmpDir();
  const inDir = path.join(root, "transcripts");
  fs.mkdirSync(inDir, { recursive: true });

  const small = transcript([msg("user", "hi", 0), msg("assistant", "hello", 1)], { id: "s1" });
  const big = transcript(
    Array.from({ length: 30 }, (_, i) => msg(i % 2 ? "assistant" : "user", "q".repeat(400), i)),
    { id: "b1" }
  );
  fs.writeFileSync(path.join(inDir, "small-s1.json"), JSON.stringify(small));
  fs.writeFileSync(path.join(inDir, "big-b1.json"), JSON.stringify(big));

  const r = chunkAll(inDir, { maxTokens: 500, charsPerToken: 4, overlap: 1 });
  assert.equal(r.transcripts, 2);
  assert.ok(r.split >= 1); // the big one split
  assert.ok(fs.existsSync(r.manifestPath));

  const manifest = JSON.parse(fs.readFileSync(r.manifestPath, "utf8"));
  assert.equal(manifest.schema, "axiomce.chatgpt-chunk-manifest/1");
  assert.equal(manifest.entries.length, r.chunks);
  // every manifest entry points at a real chunk file
  for (const e of manifest.entries) {
    assert.ok(fs.existsSync(path.join(r.outDir, e.file)), `missing chunk file ${e.file}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("chunkAll: single transcript file input works and defaults outDir to ../chunks", () => {
  const root = tmpDir();
  const inDir = path.join(root, "transcripts");
  fs.mkdirSync(inDir, { recursive: true });
  const t = transcript([msg("user", "hi", 0), msg("assistant", "hello", 1)], { id: "one" });
  const file = path.join(inDir, "one.json");
  fs.writeFileSync(file, JSON.stringify(t));

  const r = chunkAll(file, { maxTokens: 8000 });
  assert.equal(r.transcripts, 1);
  assert.equal(path.resolve(r.outDir), path.resolve(path.join(root, "chunks")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("chunkAll: skips manifest.json and non-transcript json", () => {
  const root = tmpDir();
  const inDir = path.join(root, "transcripts");
  fs.mkdirSync(inDir, { recursive: true });
  fs.writeFileSync(path.join(inDir, "manifest.json"), JSON.stringify({ schema: "axiomce.chatgpt-manifest/1" }));
  fs.writeFileSync(path.join(inDir, "stray.json"), JSON.stringify({ schema: "something-else" }));
  const t = transcript([msg("user", "hi", 0)], { id: "keep" });
  fs.writeFileSync(path.join(inDir, "keep.json"), JSON.stringify(t));

  const r = chunkAll(inDir, { maxTokens: 8000 });
  assert.equal(r.transcripts, 1); // only the real transcript
  fs.rmSync(root, { recursive: true, force: true });
});
