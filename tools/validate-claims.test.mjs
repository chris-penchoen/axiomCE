// Tests for the AxiomCE structured-claim validator. Node's built-in runner only.
// Run with:  node --test "tools/*.test.mjs"
//
// No external services, no database, no network. All claim/entity fixtures are
// synthetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateClaimShape,
  loadClaimLines,
  validateYamlFile,
  validateStore,
  CONFIDENCE_LEVELS,
} from "./validate-claims.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-vc-"));
}
function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}
function entityFile(id, cls = "public") {
  return [
    "---",
    "title: Fixture",
    "type: entity",
    `classification: ${cls}`,
    `entity_id: ${id}`,
    "updated: 2026-07-14",
    "---",
    "",
    "Body.",
  ].join("\n");
}
function goodClaim(overrides = {}) {
  return {
    id: "clm-fix-0001",
    entity: "vehicle:x",
    predicate: "color",
    value: "blue",
    confidence: "confirmed",
    classification: "public",
    valid_from: "2026-01-01",
    asserted_at: "2026-01-01T00:00:00Z",
    source: "test",
    ...overrides,
  };
}

// --- validateClaimShape: happy path ---
test("validateClaimShape accepts a well-formed claim", () => {
  assert.deepEqual(validateClaimShape(goodClaim()), []);
});

test("all documented confidence levels are accepted", () => {
  for (const c of CONFIDENCE_LEVELS) {
    assert.deepEqual(validateClaimShape(goodClaim({ confidence: c })), []);
  }
});

// --- required fields / types ---
test("missing required field is reported", () => {
  const c = goodClaim();
  delete c.source;
  assert.ok(validateClaimShape(c).some((p) => p.includes("missing required field: source")));
});

test("empty required field is reported", () => {
  assert.ok(validateClaimShape(goodClaim({ value: "" })).some((p) => p.includes("missing required field: value")));
});

test("non-string value is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ value: 42 })).some((p) => p.includes("value must be a string")));
});

test("unknown field is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ bogus: 1 })).some((p) => p.includes("unknown field: bogus")));
});

// --- enums / formats ---
test("bad confidence enum is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ confidence: "maybe" })).some((p) => p.includes("invalid confidence")));
});

test("bad classification enum is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ classification: "secret" })).some((p) => p.includes("invalid classification")));
});

test("bad id format is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ id: "claim1" })).some((p) => p.includes("invalid id format")));
});

test("bad entity id is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ entity: "Vehicle_X" })).some((p) => p.includes("invalid entity id")));
});

test("non-kebab predicate is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ predicate: "TirePressure" })).some((p) => p.includes("kebab-case")));
});

test("bad valid_from date is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ valid_from: "2026/01/01" })).some((p) => p.includes("invalid valid_from")));
});

test("bad asserted_at timestamp is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ asserted_at: "yesterday" })).some((p) => p.includes("invalid asserted_at")));
});

test("valid_to before valid_from is rejected", () => {
  const p = validateClaimShape(goodClaim({ valid_from: "2026-02-01", valid_to: "2026-01-01" }));
  assert.ok(p.some((x) => x.includes("before valid_from")));
});

test("self-supersession is rejected", () => {
  assert.ok(validateClaimShape(goodClaim({ supersedes: "clm-fix-0001" })).some((p) => p.includes("supersedes itself")));
});

test("a bare timestamp date (no time) is accepted for asserted_at", () => {
  assert.deepEqual(validateClaimShape(goodClaim({ asserted_at: "2026-01-01" })), []);
});

// --- loadClaimLines: malformed handling ---
test("loadClaimLines records malformed JSONL lines rather than throwing", () => {
  const dir = tmpDir();
  write(dir, "claims/a.jsonl", JSON.stringify(goodClaim()) + "\n{ broken\n");
  const { records, malformed } = loadClaimLines(dir);
  assert.equal(records.length, 1);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].line, 2);
});

// --- validateStore: cross-file checks ---
test("validateStore is clean for a consistent store", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x"));
  write(dir, "claims/x.jsonl", JSON.stringify(goodClaim()) + "\n");
  const { claimCount, problems } = validateStore(dir);
  assert.equal(claimCount, 1);
  assert.deepEqual(problems, []);
});

test("validateStore reports malformed JSONL", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x"));
  write(dir, "claims/x.jsonl", "{ not json\n");
  const { problems } = validateStore(dir);
  assert.ok(problems.some((p) => p.msg.includes("malformed JSON")));
});

test("validateStore reports a duplicate claim id", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x"));
  write(dir, "claims/x.jsonl", JSON.stringify(goodClaim()) + "\n" + JSON.stringify(goodClaim()) + "\n");
  const { problems } = validateStore(dir);
  assert.ok(problems.some((p) => p.msg.includes("duplicate claim id")));
});

test("validateStore reports a reference to a missing entity", () => {
  const dir = tmpDir();
  write(dir, "claims/x.jsonl", JSON.stringify(goodClaim({ entity: "vehicle:ghost" })) + "\n");
  const { problems } = validateStore(dir);
  assert.ok(problems.some((p) => p.msg.includes("references missing entity")));
});

test("validateStore reports a supersedes reference to a missing claim", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x"));
  write(dir, "claims/x.jsonl", JSON.stringify(goodClaim({ supersedes: "clm-fix-9999" })) + "\n");
  const { problems } = validateStore(dir);
  assert.ok(problems.some((p) => p.msg.includes("supersedes missing claim")));
});

// --- YAML validation ---
test("validateYamlFile rejects a tab character", () => {
  const dir = tmpDir();
  const p = write(dir, "x.yaml", "key:\n\tvalue\n");
  assert.ok(validateYamlFile(p).some((m) => m.includes("tab")));
});

test("validateYamlFile rejects a non key/list/comment line", () => {
  const dir = tmpDir();
  const p = write(dir, "x.yaml", "just some words here\n");
  assert.ok(validateYamlFile(p).some((m) => m.includes("not a comment")));
});

test("validateYamlFile flags a missing required key in ontology.yaml", () => {
  const dir = tmpDir();
  const p = write(dir, "ontology.yaml", "version: 1\nclaim: {}\n");
  assert.ok(validateYamlFile(p).some((m) => m.includes("missing required top-level key")));
});

test("validateYamlFile accepts a simple well-formed YAML", () => {
  const dir = tmpDir();
  const p = write(dir, "x.yaml", "# a comment\nkey: value\nlist:\n  - a\n  - b\n");
  assert.deepEqual(validateYamlFile(p), []);
});

// --- integration: the real store is structurally sound ---
test("the repo's own claim store validates cleanly", () => {
  const { problems } = validateStore(REPO_ROOT);
  assert.deepEqual(problems.map((p) => `${p.file}: ${p.msg}`), []);
});
