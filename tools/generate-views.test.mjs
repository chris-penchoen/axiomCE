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
  distinctValues,
  governing,
  evidenceWeight,
  contradictionAgeDays,
  isDormant,
  DEFAULT_DORMANCY_DAYS,
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
  const a = claim({ id: "clm-fix-0001", value: "blue", asserted_at: TODAY + "T00:00:00Z" });
  const b = claim({ id: "clm-fix-0002", value: "green", asserted_at: TODAY + "T00:00:00Z" });
  const { contradictions, dormant } = classify([a, b], TODAY);
  assert.ok(contradictions.has("color"));
  assert.equal(contradictions.get("color").length, 2);
  assert.equal(dormant.size, 0); // recent evidence → live, not parked
});

// --- corroboration vs contradiction (rt-corroboration-vs-contradiction) ---
test("two active claims with the SAME value are corroboration, not contradiction", () => {
  const a = claim({ id: "clm-fix-0001", value: "blue", source: "src-a" });
  const b = claim({ id: "clm-fix-0002", value: "blue", source: "src-b" });
  const { contradictions, dormant, corroborated } = classify([a, b], TODAY);
  assert.equal(contradictions.size, 0);
  assert.equal(dormant.size, 0);
  assert.ok(corroborated.has("color"));
  assert.equal(corroborated.get("color").length, 2);
});

test("corroboration is case- and whitespace-tolerant only by whitespace (case-sensitive)", () => {
  const same = classify([
    claim({ id: "clm-fix-0001", value: "dark  blue", source: "a" }),
    claim({ id: "clm-fix-0002", value: "dark blue", source: "b" }),
  ], TODAY);
  assert.ok(same.corroborated.has("color"), "collapsed whitespace agrees");

  const diff = classify([
    claim({ id: "clm-fix-0001", value: "Blue", source: "a", asserted_at: TODAY + "T00:00:00Z" }),
    claim({ id: "clm-fix-0002", value: "blue", source: "b", asserted_at: TODAY + "T00:00:00Z" }),
  ], TODAY);
  assert.ok(diff.contradictions.has("color"), "different case is NOT merged");
});

test("a genuine disagreement among otherwise-agreeing claims is still a contradiction", () => {
  const { contradictions, corroborated } = classify([
    claim({ id: "clm-fix-0001", value: "blue", source: "a", asserted_at: TODAY + "T00:00:00Z" }),
    claim({ id: "clm-fix-0002", value: "blue", source: "b", asserted_at: TODAY + "T00:00:00Z" }),
    claim({ id: "clm-fix-0003", value: "green", source: "c", asserted_at: TODAY + "T00:00:00Z" }),
  ], TODAY);
  assert.ok(contradictions.has("color"));
  assert.equal(corroborated.size, 0);
});

test("distinctValues counts normalized distinct values", () => {
  assert.equal(distinctValues([claim({ value: "blue" }), claim({ value: "blue " })]), 1);
  assert.equal(distinctValues([claim({ value: "blue" }), claim({ value: "green" })]), 2);
});

test("corroborated claims never go dormant even when old", () => {
  const OLD = "2026-01-01T00:00:00Z";
  const { corroborated, dormant } = classify([
    claim({ id: "clm-fix-0001", value: "blue", source: "a", asserted_at: OLD }),
    claim({ id: "clm-fix-0002", value: "blue", source: "b", asserted_at: OLD }),
  ], TODAY, { dormancyDays: 3 });
  assert.ok(corroborated.has("color"));
  assert.equal(dormant.size, 0);
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

// --- Axiom 12: dormancy (auto-park contradictions with no new evidence) ---
const OLD = "2026-01-01T00:00:00Z";      // ~194d before TODAY
const RECENT = "2026-07-10T00:00:00Z";   // 4d before TODAY

test("contradictionAgeDays measures days since the most recent evidence", () => {
  const a = claim({ id: "clm-fix-0001", value: "blue", asserted_at: OLD });
  const b = claim({ id: "clm-fix-0002", value: "green", asserted_at: RECENT });
  // Newest evidence is RECENT (2026-07-10) → 4 days before TODAY (2026-07-14).
  assert.equal(contradictionAgeDays([a, b], TODAY), 4);
});

test("isDormant is true past the threshold, false under it", () => {
  const list = [claim({ id: "a", value: "blue", asserted_at: OLD }), claim({ id: "b", value: "green", asserted_at: OLD })];
  assert.equal(isDormant(list, TODAY, DEFAULT_DORMANCY_DAYS), true);
  assert.equal(isDormant(list, TODAY, 365), false); // wider threshold → still live
});

test("classify parks an old, evidence-stale contradiction as dormant, not live", () => {
  const a = claim({ id: "clm-fix-0001", value: "blue", asserted_at: OLD });
  const b = claim({ id: "clm-fix-0002", value: "green", asserted_at: OLD });
  const { contradictions, dormant } = classify([a, b], TODAY);
  assert.equal(contradictions.has("color"), false); // off the active surface
  assert.ok(dormant.has("color"));                   // parked, still present
  assert.equal(dormant.get("color").length, 2);      // both sides preserved
});

test("a new observation auto-reactivates a dormant contradiction", () => {
  const a = claim({ id: "clm-fix-0001", value: "blue", asserted_at: OLD });
  const b = claim({ id: "clm-fix-0002", value: "green", asserted_at: OLD });
  // A fresh claim on the same predicate resets the evidence clock.
  const c = claim({ id: "clm-fix-0003", value: "green", source: "s2", asserted_at: RECENT });
  const { contradictions, dormant } = classify([a, b, c], TODAY);
  assert.ok(contradictions.has("color")); // live again — no explicit un-park needed
  assert.equal(dormant.size, 0);
});

test("the dormancy threshold is a configurable (human-set) policy knob", () => {
  const a = claim({ id: "a", value: "blue", asserted_at: RECENT });
  const b = claim({ id: "b", value: "green", asserted_at: RECENT });
  // 4 days old: dormant only if the threshold is set below that.
  assert.equal(classify([a, b], TODAY, { dormancyDays: 3 }).dormant.has("color"), true);
  assert.equal(classify([a, b], TODAY, { dormancyDays: 30 }).dormant.has("color"), false);
});

test("a single active claim is never dormant (dormancy needs a contradiction)", () => {
  const { contradictions, dormant } = classify([claim({ asserted_at: OLD })], TODAY);
  assert.equal(contradictions.size, 0);
  assert.equal(dormant.size, 0);
});

test("renderView shows a dormant contradiction in its own bucket, not as live", () => {
  const e = { id: "vehicle:x", title: "X", classification: "public", canonical: null, claims: null };
  const a = claim({ id: "clm-fix-0001", value: "blue", asserted_at: OLD });
  const b = claim({ id: "clm-fix-0002", value: "green", asserted_at: OLD });
  const out = renderView(e, [a, b], TODAY);
  assert.ok(out.includes("## Dormant contradictions"));
  assert.ok(out.includes("💤"));
  assert.ok(out.includes("not resolution") || out.includes("NOT resolution"));
  // The live Contradictions section reports none.
  const live = out.split("## Dormant")[0];
  assert.ok(live.includes("_None. No predicate has more than one active claim._"));
});

// --- rendering ---
test("renderView is deterministic for identical input", () => {
  const e = { id: "vehicle:x", title: "X", classification: "public", canonical: null, claims: null };
  const claims = [claim({ id: "clm-fix-0001" }), claim({ id: "clm-fix-0002", predicate: "year", value: "2019" })];
  assert.equal(renderView(e, claims, TODAY), renderView(e, claims, TODAY));
});

test("renderView marks a contradiction's governing claim", () => {
  const e = { id: "vehicle:x", title: "X", classification: "public", canonical: null, claims: null };
  const guard = claim({ id: "clm-fix-0002", confidence: "unresolved", value: "unknown", asserted_at: TODAY + "T00:00:00Z" });
  const guess = claim({ id: "clm-fix-0001", confidence: "estimate", value: "guessed", asserted_at: TODAY + "T00:00:00Z" });
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
