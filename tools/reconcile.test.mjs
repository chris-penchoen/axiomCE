// Tests for the AxiomCE reconciliation checker. Node's built-in runner only.
// Run with:  node --test "tools/*.test.mjs"
//
// No external services, no database, no network. All fixtures are synthetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadManifest, reconcile } from "./reconcile.mjs";
import { generateAll } from "./generate-views.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-rec-"));
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

// A helper that builds a store where views are already current, so only the
// reconciliation finding under test appears.
function buildStore({ canonical, manifest }) {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x", "public"));
  write(dir, "claims/x.jsonl", JSON.stringify(claim()) + "\n");
  write(dir, "vehicles/x.md", canonical);
  write(dir, "reconcile/manifest.jsonl", manifest);
  generateAll(dir); // make views current
  return dir;
}
const MANIFEST = JSON.stringify({
  entity: "vehicle:x", predicate: "color", canonical: "vehicles/x.md", token: "blue",
});

// --- loadManifest ---
test("loadManifest reads well-formed entries and flags malformed lines", () => {
  const dir = tmpDir();
  write(dir, "reconcile/manifest.jsonl", MANIFEST + "\n{ broken\n");
  const entries = loadManifest(dir);
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.__malformed));
});

// --- reconcile findings ---
test("reconcile is clean when canonical prose contains the active token", () => {
  const dir = buildStore({ canonical: "The car is blue.", manifest: MANIFEST });
  assert.deepEqual(reconcile(dir, TODAY), []);
});

test("STALE_CANONICAL when prose does not contain the token", () => {
  const dir = buildStore({ canonical: "The car is grey.", manifest: MANIFEST });
  const findings = reconcile(dir, TODAY);
  assert.ok(findings.some((f) => f.type === "STALE_CANONICAL"));
});

test("MISSING_CLAIM when the manifest field has no active claim", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x", "public"));
  write(dir, "claims/x.jsonl", JSON.stringify(claim({ predicate: "year", value: "2019" })) + "\n");
  write(dir, "vehicles/x.md", "The car is blue.");
  write(dir, "reconcile/manifest.jsonl", MANIFEST);
  generateAll(dir);
  const findings = reconcile(dir, TODAY);
  assert.ok(findings.some((f) => f.type === "MISSING_CLAIM"));
});

test("UNRESOLVED_CONTRADICTION when two active claims share the field", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x", "public"));
  write(dir, "claims/x.jsonl",
    JSON.stringify(claim({ id: "clm-fix-0001", value: "blue", asserted_at: TODAY + "T00:00:00Z" })) + "\n" +
    JSON.stringify(claim({ id: "clm-fix-0002", value: "green", asserted_at: TODAY + "T00:00:00Z" })) + "\n");
  write(dir, "vehicles/x.md", "The car is blue.");
  write(dir, "reconcile/manifest.jsonl", MANIFEST);
  generateAll(dir);
  const findings = reconcile(dir, TODAY);
  assert.ok(findings.some((f) => f.type === "UNRESOLVED_CONTRADICTION"));
});

test("DORMANT_CONTRADICTION (not UNRESOLVED) when the contradiction is evidence-stale", () => {
  const dir = tmpDir();
  write(dir, "entities/x.md", entityFile("vehicle:x", "public"));
  // Both claims old (asserted 2026-01-01, ~194d before TODAY) → parked per Axiom 12.
  write(dir, "claims/x.jsonl",
    JSON.stringify(claim({ id: "clm-fix-0001", value: "blue" })) + "\n" +
    JSON.stringify(claim({ id: "clm-fix-0002", value: "green" })) + "\n");
  write(dir, "vehicles/x.md", "The car is blue.");
  write(dir, "reconcile/manifest.jsonl", MANIFEST);
  generateAll(dir);
  const findings = reconcile(dir, TODAY);
  assert.ok(findings.some((f) => f.type === "DORMANT_CONTRADICTION"));
  assert.ok(!findings.some((f) => f.type === "UNRESOLVED_CONTRADICTION"));
});

test("STALE_VIEW when a generated view is out of date", () => {
  const dir = buildStore({ canonical: "The car is blue.", manifest: MANIFEST });
  fs.writeFileSync(path.join(dir, "views", "vehicle-x.view.md"), "tampered\n", "utf8");
  const findings = reconcile(dir, TODAY);
  assert.ok(findings.some((f) => f.type === "STALE_VIEW"));
});

test("MANIFEST_ERROR for a malformed manifest line", () => {
  const dir = buildStore({ canonical: "The car is blue.", manifest: MANIFEST + "\n{ broken\n" });
  const findings = reconcile(dir, TODAY);
  assert.ok(findings.some((f) => f.type === "MANIFEST_ERROR"));
});

test("reconcile never writes to the canonical file", () => {
  const dir = buildStore({ canonical: "The car is grey.", manifest: MANIFEST });
  const before = fs.readFileSync(path.join(dir, "vehicles", "x.md"), "utf8");
  reconcile(dir, TODAY);
  const after = fs.readFileSync(path.join(dir, "vehicles", "x.md"), "utf8");
  assert.equal(before, after);
});

// --- integration: the real repo reconciles cleanly ---
test("the repo's own store reconciles with no findings", () => {
  const findings = reconcile(REPO_ROOT);
  assert.deepEqual(findings.map((f) => `${f.type}: ${f.detail}`), []);
});
