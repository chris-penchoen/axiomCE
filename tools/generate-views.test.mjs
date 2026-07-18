// Tests for the AxiomCE view projector. Node's built-in runner only.
// Run with:  node --test "tools/*.test.mjs"
//
// No external services, no database, no network. All fixtures are synthetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classify,
  governing,
  evidenceWeight,
  renderView,
  viewPath,
  generateAll,
  GOVERNANCE_PRECEDENCE,
} from "./generate-views.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-gv-"));
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
function claim(overrides = {}) {
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
    valid_to: null,
    retracted_at: null,
    ...overrides,
  };
}
const TODAY = "2026-07-14";

// --- classify: lifecycle ---
test("a plain claim is active", () => {
  const { active, history } = classify([claim()], TODAY);
  assert.equal(active.length, 1);
  assert.equal(history.length, 0);
});

test("supersession moves the old claim to history", () => {
  const a = claim({ id: "clm-fix-0001", value: "blue" });
  const b = claim({ id: "clm-fix-0002", value: "red", supersedes: "clm-fix-0001" });
  const { active, history } = classify([a, b], TODAY);
  assert.deepEqual(active.map((c) => c.id), ["clm-fix-0002"]);
  assert.deepEqual(history.map((c) => c.id), ["clm-fix-0001"]);
});

test("retraction moves a claim to history", () => {
  const a = claim({ retracted_at: "2026-05-01T00:00:00Z" });
  const { active, history } = classify([a], TODAY);
  assert.equal(active.length, 0);
  assert.equal(history.length, 1);
});

test("a valid_to in the past expires the claim", () => {
  const a = claim({ valid_to: "2026-06-01" });
  const { active, history } = classify([a], TODAY);
  assert.equal(active.length, 0);
  assert.equal(history.length, 1);
});

test("a valid_to in the future keeps the claim active", () => {
  const a = claim({ valid_to: "2026-12-01" });
  const { active } = classify([a], TODAY);
  assert.equal(active.length, 1);
});

test("a future valid_from claim is still active by lifecycle (not expired)", () => {
  const a = claim({ valid_from: "2026-12-01" });
  const { active } = classify([a], TODAY);
  assert.equal(active.length, 1);
});

test("two active claims on the same predicate are a contradiction", () => {
  const a = claim({ id: "clm-fix-0001", value: "blue" });
  const b = claim({ id: "clm-fix-0002", value: "green" });
  const { contradictions } = classify([a, b], TODAY);
  assert.ok(contradictions.has("color"));
  assert.equal(contradictions.get("color").length, 2);
});

// --- governing precedence ---
test("GOVERNANCE_PRECEDENCE ranks unresolved above estimate", () => {
  assert.ok(
    GOVERNANCE_PRECEDENCE.indexOf("unresolved") < GOVERNANCE_PRECEDENCE.indexOf("estimate")
  );
});

test("an unresolved guard outranks an optimistic estimate", () => {
  const guard = claim({ id: "clm-fix-0002", confidence: "unresolved", value: "unknown" });
  const guess = claim({ id: "clm-fix-0001", confidence: "estimate", value: "$5,000" });
  assert.equal(governing([guess, guard]).id, "clm-fix-0002");
});

test("confirmed outranks everything; ties broken by lowest id", () => {
  const c1 = claim({ id: "clm-fix-0003", confidence: "confirmed" });
  const c2 = claim({ id: "clm-fix-0001", confidence: "confirmed" });
  assert.equal(governing([c1, c2]).id, "clm-fix-0001");
});

// --- Axiom 10: evidence outranks confidence ---
test("evidenceWeight counts distinct sources asserting the same value", () => {
  const list = [
    claim({ id: "a", value: "blue", source: "s1" }),
    claim({ id: "b", value: "blue", source: "s2" }),
    claim({ id: "c", value: "blue", source: "s1" }), // dup source — not counted twice
    claim({ id: "d", value: "green", source: "s3" }),
  ];
  assert.equal(evidenceWeight(list[0], list), 2); // blue: {s1, s2}
  assert.equal(evidenceWeight(list[3], list), 1); // green: {s3}
});

test("a well-corroborated inferred value outranks a lone confident claim", () => {
  const confident = claim({ id: "clm-fix-0001", confidence: "confirmed", value: "blue", source: "s1" });
  const corr1 = claim({ id: "clm-fix-0002", confidence: "inferred", value: "green", source: "s2" });
  const corr2 = claim({ id: "clm-fix-0003", confidence: "inferred", value: "green", source: "s3" });
  const corr3 = claim({ id: "clm-fix-0004", confidence: "inferred", value: "green", source: "s4" });
  // green: 3 distinct sources vs blue: 1 → evidence outranks the confident label.
  assert.equal(governing([confident, corr1, corr2, corr3]).value, "green");
});

test("disconfirming evidence cuts hardest: opposing weight beats a confident claim", () => {
  const confident = claim({ id: "clm-fix-0001", confidence: "confirmed", value: "$400", source: "s1" });
  const dis1 = claim({ id: "clm-fix-0002", confidence: "user-stated", value: "$250", source: "s2" });
  const dis2 = claim({ id: "clm-fix-0003", confidence: "user-stated", value: "$250", source: "s3" });
  assert.equal(governing([confident, dis1, dis2]).value, "$250");
});

test("at equal evidence, confidence precedence (safety nuance) still decides", () => {
  const guard = claim({ id: "clm-fix-0002", confidence: "unresolved", value: "unknown", source: "s1" });
  const guess = claim({ id: "clm-fix-0001", confidence: "estimate", value: "$5,000", source: "s2" });
  // 1 source each → tie on evidence → unresolved outranks estimate.
  assert.equal(governing([guess, guard]).id, "clm-fix-0002");
});

test("duplicate sources do not inflate evidence weight", () => {
  const a = claim({ id: "clm-fix-0001", confidence: "inferred", value: "blue", source: "same" });
  const b = claim({ id: "clm-fix-0002", confidence: "inferred", value: "blue", source: "same" });
  const c = claim({ id: "clm-fix-0003", confidence: "user-stated", value: "red", source: "other" });
  // blue: {same} = 1, red: {other} = 1 → tie → user-stated outranks inferred.
  assert.equal(governing([a, b, c]).value, "red");
});

// --- rendering ---
test("renderView is deterministic for identical input", () => {
  const e = { id: "vehicle:x", title: "X", classification: "public", canonical: null, claims: null };
  const claims = [claim({ id: "clm-fix-0001" }), claim({ id: "clm-fix-0002", predicate: "year", value: "2019" })];
  assert.equal(renderView(e, claims, TODAY), renderView(e, claims, TODAY));
});

test("renderView marks a contradiction's governing claim", () => {
  const e = { id: "vehicle:x", title: "X", classification: "public", canonical: null, claims: null };
  const guard = claim({ id: "clm-fix-0002", confidence: "unresolved", value: "unknown" });
  const guess = claim({ id: "clm-fix-0001", confidence: "estimate", value: "guessed" });
  const out = renderView(e, [guard, guess], TODAY);
  assert.ok(out.includes("governing: `clm-fix-0002`"));
  assert.ok(out.includes("← governs"));
});

// --- routing ---
test("viewPath routes public/personal entities to views/", () => {
  const root = tmpDir();
  const p = viewPath({ id: "vehicle:x", classification: "public" }, root);
  assert.equal(path.relative(root, p), path.join("views", "vehicle-x.view.md"));
});

test("viewPath routes restricted/sensitive entities to private/views/", () => {
  const root = tmpDir();
  for (const cls of ["restricted", "sensitive"]) {
    const p = viewPath({ id: "vehicle:x", classification: cls }, root);
    assert.equal(path.relative(root, p), path.join("private", "views", "vehicle-x.view.md"));
  }
});

// --- generateAll end-to-end ---
test("generateAll writes a public view to views/ and reports not-stale on re-check", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x", "public"));
  write(dir, "claims/x.jsonl", JSON.stringify(claim()) + "\n");
  const first = generateAll(dir);
  assert.equal(first.length, 1);
  assert.ok(fs.existsSync(path.join(dir, "views", "vehicle-x.view.md")));
  const check = generateAll(dir, { check: true });
  assert.equal(check[0].stale, false);
});

test("generateAll routes a restricted entity's view under private/views/", () => {
  const dir = tmpDir();
  write(dir, "private/entities/x.md", entityFile("vehicle:x", "restricted"));
  write(dir, "private/claims/x.jsonl", JSON.stringify(claim({ classification: "restricted" })) + "\n");
  generateAll(dir);
  assert.ok(fs.existsSync(path.join(dir, "private", "views", "vehicle-x.view.md")));
  assert.ok(!fs.existsSync(path.join(dir, "views", "vehicle-x.view.md")));
});

test("generateAll --check flags a stale view", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x", "public"));
  write(dir, "claims/x.jsonl", JSON.stringify(claim()) + "\n");
  generateAll(dir);
  write(dir, "views/vehicle-x.view.md", "stale content\n");
  const check = generateAll(dir, { check: true });
  assert.equal(check[0].stale, true);
});
