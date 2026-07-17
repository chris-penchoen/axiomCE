// Tests for tools/extract-harness.mjs — deterministic extraction orchestrator.
// Node's built-in runner only. No network, no model, no external deps.
// Run with:  node --test "tools/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildExtractionPrompt,
  validateEnvelopeCandidate,
  planExtraction,
  ingestEnvelopes,
  status,
} from "./extract-harness.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-xtract-"));
}

function chunk(overrides = {}) {
  return {
    schema: "axiomce.chatgpt-chunk/1",
    conversation_id: "abc",
    source: "chatgpt:abc",
    title: "T",
    chunk_index: 0,
    chunk_count: 2,
    context_prefix: 1,
    est_tokens: 10,
    messages: [
      { role: "assistant", create_time: "2026-01-01T00:00:00.000Z", text: "prior context" },
      { role: "user", create_time: "2026-01-02T00:00:00.000Z", text: "I drive a 2019 Subaru." },
    ],
    ...overrides,
  };
}

// A minimal valid envelope candidate for source chatgpt:abc.
function cand(overrides = {}) {
  return {
    id_domain: "cg",
    entity: "person:me",
    predicate: "drives-vehicle",
    value: "2019 Subaru",
    confidence: "user-stated",
    classification: "personal",
    valid_from: "2026-01-02",
    source: "chatgpt:abc",
    ...overrides,
  };
}

// -- buildExtractionPrompt --------------------------------------------------

test("buildExtractionPrompt: embeds the exact source token and the F-rules", () => {
  const p = buildExtractionPrompt(chunk());
  assert.match(p, /MUST be exactly "chatgpt:abc"/);
  assert.match(p, /F1 State, not aspiration/);
  assert.match(p, /F7 Never-store/);
  assert.match(p, /NEVER emit "confirmed"/);
});

test("buildExtractionPrompt: marks the context_prefix messages read-only and includes body", () => {
  const p = buildExtractionPrompt(chunk());
  assert.match(p, /assistant \[READ-ONLY CONTEXT\]/);
  assert.match(p, /I drive a 2019 Subaru\./);
  // the non-context user message is NOT tagged read-only
  assert.doesNotMatch(p, /user \[READ-ONLY CONTEXT\]/);
});

// -- validateEnvelopeCandidate ---------------------------------------------

test("validateEnvelopeCandidate: a clean candidate passes", () => {
  assert.deepEqual(validateEnvelopeCandidate(cand(), { expectedSource: "chatgpt:abc" }), []);
});

test("validateEnvelopeCandidate: missing required field is caught", () => {
  const c = cand();
  delete c.predicate;
  const problems = validateEnvelopeCandidate(c, { expectedSource: "chatgpt:abc" });
  assert.ok(problems.some((p) => p.includes("missing required field: predicate")));
});

test("validateEnvelopeCandidate: id_domain required when id omitted", () => {
  const c = cand();
  delete c.id_domain;
  const problems = validateEnvelopeCandidate(c, { expectedSource: "chatgpt:abc" });
  assert.ok(problems.some((p) => p.includes("missing id and id_domain")));
});

test("validateEnvelopeCandidate: unknown field rejected", () => {
  const problems = validateEnvelopeCandidate(cand({ extractor: "gpt" }), { expectedSource: "chatgpt:abc" });
  assert.ok(problems.some((p) => p.includes("unknown field: extractor")));
});

test("validateEnvelopeCandidate: PROVENANCE guard — mismatched source rejected (F9)", () => {
  const problems = validateEnvelopeCandidate(cand({ source: "chatgpt:WRONG" }), { expectedSource: "chatgpt:abc" });
  assert.ok(problems.some((p) => p.includes("does not match chunk source")));
});

test("validateEnvelopeCandidate: CONFIDENCE CEILING — confirmed rejected (F5/F9)", () => {
  const problems = validateEnvelopeCandidate(cand({ confidence: "confirmed" }), { expectedSource: "chatgpt:abc" });
  assert.ok(problems.some((p) => p.includes("not allowed for an AI-conversation import")));
});

test("validateEnvelopeCandidate: bad enums/regex caught", () => {
  const c = cand({ confidence: "sure", classification: "secret", entity: "BadEntity", predicate: "Not_Kebab", valid_from: "07/2026" });
  const problems = validateEnvelopeCandidate(c, { expectedSource: "chatgpt:abc" });
  assert.ok(problems.some((p) => p.includes("invalid confidence")));
  assert.ok(problems.some((p) => p.includes("invalid classification")));
  assert.ok(problems.some((p) => p.includes("invalid entity")));
  assert.ok(problems.some((p) => p.includes("invalid predicate")));
  assert.ok(problems.some((p) => p.includes("invalid valid_from")));
});

// -- plan / ingest / status (filesystem) -----------------------------------

// Write a minimal chunks dir + manifest with two chunks of one conversation.
function seedChunks(root) {
  const chunksDir = path.join(root, "chunks");
  fs.mkdirSync(chunksDir, { recursive: true });
  const c0 = chunk({ chunk_index: 0, chunk_count: 2, context_prefix: 0 });
  const c1 = chunk({ chunk_index: 1, chunk_count: 2, context_prefix: 1 });
  fs.writeFileSync(path.join(chunksDir, "abc.chunk-0.json"), JSON.stringify(c0));
  fs.writeFileSync(path.join(chunksDir, "abc.chunk-1.json"), JSON.stringify(c1));
  fs.writeFileSync(
    path.join(chunksDir, "manifest.json"),
    JSON.stringify({
      schema: "axiomce.chatgpt-chunk-manifest/1",
      entries: [
        { file: "abc.chunk-0.json", conversation_id: "abc", source: "chatgpt:abc", chunk_index: 0, chunk_count: 2, est_tokens: 10 },
        { file: "abc.chunk-1.json", conversation_id: "abc", source: "chatgpt:abc", chunk_index: 1, chunk_count: 2, est_tokens: 20 },
      ],
    })
  );
  return chunksDir;
}

test("planExtraction: builds a resumable task queue from the chunk manifest", () => {
  const root = tmpDir();
  const chunksDir = seedChunks(root);
  const workDir = path.join(root, "extraction");
  const r = planExtraction(chunksDir, { workDir });
  assert.equal(r.planned, 2);
  const tasks = fs.readFileSync(path.join(workDir, "tasks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, "pending");
  assert.equal(tasks[0].source, "chatgpt:abc");
  fs.rmSync(root, { recursive: true, force: true });
});

test("planExtraction: re-running preserves existing task status (resumable)", () => {
  const root = tmpDir();
  const chunksDir = seedChunks(root);
  const workDir = path.join(root, "extraction");
  planExtraction(chunksDir, { workDir });
  // Mark one task ingested, then re-plan.
  const tp = path.join(workDir, "tasks.jsonl");
  const tasks = fs.readFileSync(tp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  tasks[0].status = "ingested";
  fs.writeFileSync(tp, tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  planExtraction(chunksDir, { workDir });
  const after = fs.readFileSync(tp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(after.find((t) => t.task === tasks[0].task).status, "ingested");
  fs.rmSync(root, { recursive: true, force: true });
});

test("planExtraction: --only and --limit filter the queue", () => {
  const root = tmpDir();
  const chunksDir = seedChunks(root);
  const workDir = path.join(root, "extraction");
  const r = planExtraction(chunksDir, { workDir, limit: 1 });
  assert.equal(r.planned, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("ingestEnvelopes: validates, files valid observations, records rejects + extractor", () => {
  const root = tmpDir();
  const chunksDir = seedChunks(root);
  const workDir = path.join(root, "extraction");
  planExtraction(chunksDir, { workDir });

  // chunk-0: one valid candidate + one bad (wrong source) + one confirmed (ceiling)
  fs.writeFileSync(
    path.join(workDir, "results", "abc.chunk-0.jsonl"),
    [
      JSON.stringify(cand()),
      JSON.stringify(cand({ source: "chatgpt:WRONG" })),
      JSON.stringify(cand({ confidence: "confirmed", predicate: "born-in" })),
      "// a comment line",
      "{ not json",
    ].join("\n")
  );

  const r = ingestEnvelopes(workDir, { extractor: "test-model" });
  assert.equal(r.ingested_tasks, 1);
  assert.equal(r.valid, 1);
  assert.ok(r.rejected >= 3); // wrong source, confirmed, malformed
  assert.ok(fs.existsSync(r.observationsFile));

  const obs = fs.readFileSync(r.observationsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(obs.length, 1);
  assert.equal(obs[0].source, "chatgpt:abc");

  // batch manifest records the extractor
  const manifestFile = r.observationsFile.replace(/\.jsonl$/, ".manifest.json");
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(m.extractor, "test-model");
  assert.equal(m.valid, 1);

  // task marked ingested
  const tasks = fs.readFileSync(path.join(workDir, "tasks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(tasks.find((t) => t.task === "abc.chunk-0").status, "ingested");
  fs.rmSync(root, { recursive: true, force: true });
});

test("ingestEnvelopes: dedupes identical candidates within the batch", () => {
  const root = tmpDir();
  const chunksDir = seedChunks(root);
  const workDir = path.join(root, "extraction");
  planExtraction(chunksDir, { workDir });
  fs.writeFileSync(
    path.join(workDir, "results", "abc.chunk-0.jsonl"),
    [JSON.stringify(cand()), JSON.stringify(cand())].join("\n")
  );
  const r = ingestEnvelopes(workDir, {});
  assert.equal(r.valid, 1);
  assert.equal(r.duplicates, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("status: reports pending/extracted/ingested", () => {
  const root = tmpDir();
  const chunksDir = seedChunks(root);
  const workDir = path.join(root, "extraction");
  planExtraction(chunksDir, { workDir });
  // drop a result for one chunk -> it should read as 'extracted'
  fs.writeFileSync(path.join(workDir, "results", "abc.chunk-0.jsonl"), JSON.stringify(cand()) + "\n");
  const s = status(workDir);
  assert.equal(s.total, 2);
  assert.equal(s.extracted, 1);
  assert.equal(s.pending, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
