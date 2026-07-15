// Tests for the AxiomCE continuity runner (project + capture).
// Node's built-in runner only. No external services, database, or network.
// Run with:  node --test "tools/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claimLogPath,
  nextClaimId,
  assembleContext,
  captureContract,
  planCapture,
  applyCapture,
} from "./runner.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-run-"));
}
function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}
function entityFile(id, cls = "public", title = "Fixture") {
  return [
    "---",
    `title: ${title}`,
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
    entity: "organization:fix",
    predicate: "color",
    value: "blue",
    confidence: "confirmed",
    classification: "personal",
    valid_from: "2026-01-01",
    asserted_at: "2026-01-01T00:00:00Z",
    source: "test",
    valid_to: null,
    retracted_at: null,
    ...overrides,
  };
}
const TODAY = "2026-07-14";

/** Minimal store with one public entity + one active claim. */
function seedStore(dir) {
  write(dir, "entities/fix.md", entityFile("organization:fix", "public", "Fix Co"));
  write(dir, "claims/organization-fix.jsonl", JSON.stringify(claim()) + "\n");
  write(dir, "CURRENT_CONTEXT.md", ["---", "title: Current Context", "type: context", "classification: personal", "updated: 2026-07-14", "---", "", "## Active priorities", "", "- Ship the runner."].join("\n"));
}

// --- routing ---
test("claimLogPath routes public/personal to claims/", () => {
  const root = tmpDir();
  assert.equal(
    path.relative(root, claimLogPath("organization:acme", "personal", root)),
    path.join("claims", "organization-acme.jsonl")
  );
});

test("claimLogPath routes restricted/sensitive to private/claims/", () => {
  const root = tmpDir();
  for (const cls of ["restricted", "sensitive"]) {
    assert.equal(
      path.relative(root, claimLogPath("vehicle:sedan-01", cls, root)),
      path.join("private", "claims", "vehicle-sedan-01.jsonl")
    );
  }
});

// --- id minting ---
test("nextClaimId returns 0001 for an unseen domain", () => {
  assert.equal(nextClaimId([], "acme"), "clm-acme-0001");
});

test("nextClaimId returns max+1 and preserves width", () => {
  const claims = [{ id: "clm-acme-0011" }, { id: "clm-acme-0009" }, { id: "clm-sedan-0003" }];
  assert.equal(nextClaimId(claims, "acme"), "clm-acme-0012");
  assert.equal(nextClaimId(claims, "sedan"), "clm-sedan-0004");
});

// --- project ---
test("assembleContext lists active facts and is deterministic", () => {
  const dir = tmpDir();
  seedStore(dir);
  const a = assembleContext(dir, { today: TODAY }).markdown;
  const b = assembleContext(dir, { today: TODAY }).markdown;
  assert.equal(a, b);
  assert.ok(a.includes("organization:fix"));
  assert.ok(a.includes("**color**"));
  assert.ok(a.includes("Ship the runner."));
});

test("assembleContext excludes private entities by default, includes with flag", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "private/entities/sedan.md", entityFile("vehicle:sedan-01", "restricted", "Sedan"));
  write(dir, "private/claims/vehicle-sedan-01.jsonl",
    JSON.stringify(claim({ id: "clm-sedan-0001", entity: "vehicle:sedan-01", classification: "restricted", predicate: "ride-height", value: "custom suspension" })) + "\n");

  const pub = assembleContext(dir, { today: TODAY }).markdown;
  assert.ok(!pub.includes("vehicle:sedan-01"));

  const full = assembleContext(dir, { today: TODAY, includePrivate: true }).markdown;
  assert.ok(full.includes("vehicle:sedan-01"));
  assert.ok(full.includes("LOCAL-ONLY"));
});

test("assembleContext surfaces a contradiction with the governing claim", () => {
  const dir = tmpDir();
  write(dir, "entities/fix.md", entityFile("organization:fix", "public"));
  write(dir, "claims/organization-fix.jsonl",
    [
      JSON.stringify(claim({ id: "clm-fix-0001", predicate: "status", value: "guessed", confidence: "estimate" })),
      JSON.stringify(claim({ id: "clm-fix-0002", predicate: "status", value: "unknown", confidence: "unresolved" })),
    ].join("\n") + "\n");
  const md = assembleContext(dir, { today: TODAY }).markdown;
  // unresolved guard outranks estimate.
  assert.ok(md.includes("rely on `clm-fix-0002`"));
  assert.ok(md.includes("Open questions"));
});

test("assembleContext with an entity filter narrows scope", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "entities/other.md", entityFile("organization:other", "public", "Other"));
  write(dir, "claims/organization-other.jsonl",
    JSON.stringify(claim({ id: "clm-other-0001", entity: "organization:other" })) + "\n");
  const md = assembleContext(dir, { today: TODAY, entities: ["organization:fix"] }).markdown;
  assert.ok(md.includes("organization:fix"));
  assert.ok(!md.includes("organization:other"));
});

test("assembleContext embeds the capture contract when the spec is present", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "inbox/capture-envelope-spec.md", [
    "---", "title: Spec", "type: spec", "classification: personal", "updated: 2026-07-15", "---",
    "", "## Envelope format", "", "- one JSON object per line.",
    "", "## Fidelity rules (normative)", "", "- **F2 — Preserve negation.** An exclusion is a fact.",
    "", "## Worked example", "", "(omitted)",
  ].join("\n"));
  const { markdown, manifest } = assembleContext(dir, { today: TODAY });
  assert.ok(markdown.includes("## Writing back (capture contract)"));
  assert.ok(markdown.includes("F2 — Preserve negation"));
  assert.ok(markdown.includes("one JSON object per line."));
  assert.ok(!markdown.includes("(omitted)")); // worked example is not pulled in
  assert.equal(manifest.capture_contract, "inbox/capture-envelope-spec.md");
});

test("assembleContext falls back gracefully when the spec is absent", () => {
  const dir = tmpDir();
  seedStore(dir);
  const { markdown, manifest } = assembleContext(dir, { today: TODAY });
  assert.ok(markdown.includes("## Writing back (capture contract)"));
  assert.ok(markdown.includes("See `inbox/capture-envelope-spec.md`"));
  assert.equal(manifest.capture_contract, null);
});

// --- capture ---
function envelope(dir, lines) {
  return write(dir, "envelope.jsonl", lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

test("planCapture mints ids and routes a valid candidate (dry-run plan)", () => {
  const dir = tmpDir();
  seedStore(dir);
  const env = envelope(dir, [
    { id_domain: "fix", entity: "organization:fix", predicate: "website-platform", value: "Webflow", confidence: "user-stated", classification: "personal", valid_from: "2026-07-15", source: "chat-2026-07-15" },
  ]);
  const { planned, problems } = planCapture(dir, env, { now: "2026-07-15T00:00:00Z" });
  assert.equal(problems.length, 0);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].claim.id, "clm-fix-0002");
  assert.equal(planned[0].target, path.join("claims", "organization-fix.jsonl"));
  assert.equal(planned[0].claim.asserted_at, "2026-07-15T00:00:00Z");
});

test("planCapture mints sequential ids within a batch", () => {
  const dir = tmpDir();
  seedStore(dir);
  const env = envelope(dir, [
    { id_domain: "fix", entity: "organization:fix", predicate: "a", value: "1", confidence: "user-stated", classification: "personal", valid_from: "2026-07-15", source: "s" },
    { id_domain: "fix", entity: "organization:fix", predicate: "b", value: "2", confidence: "user-stated", classification: "personal", valid_from: "2026-07-15", source: "s" },
  ]);
  const { planned } = planCapture(dir, env, {});
  assert.deepEqual(planned.map((p) => p.claim.id), ["clm-fix-0002", "clm-fix-0003"]);
});

test("planCapture rejects a candidate for a missing entity", () => {
  const dir = tmpDir();
  seedStore(dir);
  const env = envelope(dir, [
    { id_domain: "ghost", entity: "vehicle:ghost", predicate: "a", value: "1", confidence: "user-stated", classification: "personal", valid_from: "2026-07-15", source: "s" },
  ]);
  const { problems } = planCapture(dir, env, {});
  assert.ok(problems.some((p) => /missing entity/.test(p.msg)));
});

test("planCapture requires id_domain when id is absent", () => {
  const dir = tmpDir();
  seedStore(dir);
  const env = envelope(dir, [
    { entity: "organization:fix", predicate: "a", value: "1", confidence: "user-stated", classification: "personal", valid_from: "2026-07-15", source: "s" },
  ]);
  const { problems } = planCapture(dir, env, {});
  assert.ok(problems.some((p) => /id_domain/.test(p.msg)));
});

test("planCapture blocks a never-store secret even under private classification", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "private/entities/sedan.md", entityFile("vehicle:sedan-01", "restricted"));
  const env = envelope(dir, [
    { id_domain: "sedan", entity: "vehicle:sedan-01", predicate: "note", value: "token: abcdef1234567890secret", confidence: "user-stated", classification: "restricted", valid_from: "2026-07-15", source: "s" },
  ]);
  const { problems } = planCapture(dir, env, {});
  assert.ok(problems.some((p) => /never-store secret/.test(p.msg)));
});

test("planCapture blocks sensitive data in a tracked (non-private) claim", () => {
  const dir = tmpDir();
  seedStore(dir);
  const env = envelope(dir, [
    { id_domain: "fix", entity: "organization:fix", predicate: "pay", value: "net pay is $4,200 per paycheck", confidence: "user-stated", classification: "personal", valid_from: "2026-07-15", source: "s" },
  ]);
  const { problems } = planCapture(dir, env, {});
  assert.ok(problems.some((p) => /sensitive data in a tracked claim/.test(p.msg)));
});

test("applyCapture appends append-only and is re-readable", () => {
  const dir = tmpDir();
  seedStore(dir);
  const env = envelope(dir, [
    { id_domain: "fix", entity: "organization:fix", predicate: "b", value: "2", confidence: "user-stated", classification: "personal", valid_from: "2026-07-15", source: "s" },
  ]);
  const { planned } = planCapture(dir, env, {});
  const { appended } = applyCapture(dir, planned);
  assert.equal(appended.length, 1);
  const logPath = path.join(dir, "claims", "organization-fix.jsonl");
  const lines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 2); // original + appended
  assert.equal(JSON.parse(lines[0]).id, "clm-fix-0001"); // original untouched
  assert.equal(JSON.parse(lines[1]).id, "clm-fix-0002");
  // No BOM.
  assert.notEqual(fs.readFileSync(logPath, "utf8").charCodeAt(0), 0xfeff);
});
