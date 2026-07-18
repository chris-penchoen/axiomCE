// Tests for the AxiomCE continuity runner (project + capture + sync + ratify).
// Node's built-in runner only. No external services, database, or network.
// Run with:  node --test "tools/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));

import {
  claimLogPath,
  nextClaimId,
  assembleContext,
  captureContract,
  planCapture,
  applyCapture,
  candidateHash,
  factFingerprint,
  loadLedger,
  loadQueue,
  planSync,
  applySync,
  publishObservation,
  observationFiles,
  isObservationFile,
  archiveProcessed,
  QUEUE_DEPTH_WARN,
  withWriterLock,
  applyDeadLetter,
  loadDeadLetter,
  deadLetterKey,
  planRatify,
  applyRatify,
  triageBucket,
  triageQueue,
  TRIAGE_BUCKETS,
  classAtOrBelow,
  DEFAULT_RATIFY_POLICY,
  decisiveResolution,
  planAutoRatify,
  applyAutoRatify,
  planRetract,
  applyRetract,
  planRecover,
  applyRecover,
  RUNTIME_SCHEMA_VERSION,
  readSchemaVersion,
  ensureSchema,
  MIGRATIONS,
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

test("claimLogPath is fail-closed: missing/unknown classification quarantines to private/claims/", () => {
  const root = tmpDir();
  for (const cls of [null, undefined, "", "secret", "public-ish", "internal"]) {
    assert.equal(
      path.relative(root, claimLogPath("person:jdoe", cls, root)),
      path.join("private", "claims", "person-jdoe.jsonl"),
      `classification ${JSON.stringify(cls)} must route private`
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
      JSON.stringify(claim({ id: "clm-fix-0001", predicate: "status", value: "guessed", confidence: "estimate", asserted_at: TODAY + "T00:00:00Z" })),
      JSON.stringify(claim({ id: "clm-fix-0002", predicate: "status", value: "unknown", confidence: "unresolved", asserted_at: TODAY + "T00:00:00Z" })),
    ].join("\n") + "\n");
  const md = assembleContext(dir, { today: TODAY }).markdown;
  // Rendered faithfully as UNRESOLVED (Axiom 11), not downplayed to one claim.
  assert.ok(md.includes("UNRESOLVED contradiction"));
  assert.ok(md.includes("not auto-resolved"));
  assert.ok(md.includes("not a settled ruling"));
  // Evidence is tied (1 source each) → unresolved guard outranks estimate as
  // the governing default (Axiom 10 tiebreak = confidence precedence).
  assert.ok(md.includes("governing default `clm-fix-0002`"));
  // The losing side stays visible, not erased.
  assert.ok(md.includes("clm-fix-0001"));
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

// --- sync (continuous ingest) ---
function observe(dir, name, lines) {
  return write(dir, path.join("inbox", "observations", name),
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}
function obsClaim(over = {}) {
  return { id_domain: "fix", entity: "organization:fix", predicate: "p", value: "v",
    confidence: "user-stated", classification: "personal", valid_from: "2026-07-15", source: "s", ...over };
}

test("candidateHash ignores id/asserted_at but changes with semantic content", () => {
  const base = obsClaim();
  delete base.id_domain;
  const h1 = candidateHash({ ...base, id: "clm-fix-9", asserted_at: "2026-01-01T00:00:00Z" });
  const h2 = candidateHash({ ...base, id: "clm-zzz-1", asserted_at: "2030-12-31T00:00:00Z" });
  assert.equal(h1, h2); // minted fields don't affect the hash
  assert.notEqual(h1, candidateHash({ ...base, value: "different" }));
  assert.match(h1, /^obs-[0-9a-f]{32}$/);
});

test("planSync queues new candidates and routes private vs public targets", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "private/entities/sedan.md", entityFile("vehicle:sedan-01", "restricted"));
  observe(dir, "obs1.jsonl", [
    obsClaim({ id_domain: "fix", predicate: "p1", value: "v1" }),
    obsClaim({ id_domain: "sedan", entity: "vehicle:sedan-01", predicate: "p2", value: "v2", classification: "restricted" }),
  ]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan.problems.length, 0);
  assert.equal(plan.queued.length, 2);
  const pub = plan.queued.find((q) => !q.private);
  const prv = plan.queued.find((q) => q.private);
  assert.equal(pub.target, path.join("claims", "organization-fix.jsonl"));
  assert.equal(prv.target, path.join("private", "claims", "vehicle-sedan-01.jsonl"));
});

test("applySync + planSync are idempotent (ledger dedup makes re-runs no-ops)", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({ predicate: "p1", value: "v1" })]);
  const plan1 = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan1.queued.length, 1);
  applySync(dir, plan1, { now: "2026-07-15T00:00:00.000Z" });
  const plan2 = planSync(dir, { now: "2026-07-15T00:00:01Z" });
  assert.equal(plan2.queued.length, 0);
  assert.equal(plan2.duplicates.length, 1);
});

test("applySync routes queue/ledger public vs private and writes a value-free run manifest", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "private/entities/sedan.md", entityFile("vehicle:sedan-01", "restricted"));
  observe(dir, "obs1.jsonl", [
    obsClaim({ id_domain: "fix", predicate: "p1", value: "v1" }),
    obsClaim({ id_domain: "sedan", entity: "vehicle:sedan-01", predicate: "p2", value: "SENSITIVEVAL", classification: "restricted" }),
  ]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  const res = applySync(dir, plan, { now: "2026-07-15T00:00:00.000Z" });
  assert.equal(res.queuedCount, 2);

  const pubQ = fs.readFileSync(path.join(dir, "runtime", "ratification-queue.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(pubQ.length, 1);
  assert.equal(JSON.parse(pubQ[0]).claim.entity, "organization:fix");
  const prvQ = fs.readFileSync(path.join(dir, "private", "runtime", "ratification-queue.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(prvQ.length, 1);
  assert.equal(JSON.parse(prvQ[0]).claim.entity, "vehicle:sedan-01");

  // Sensitive VALUE must never appear in a tracked runtime file.
  assert.ok(!fs.readFileSync(path.join(dir, "runtime", "ledger.jsonl"), "utf8").includes("SENSITIVEVAL"));
  const manifestAbs = path.join(dir, res.runManifestPath);
  const trackedManifest = JSON.parse(fs.readFileSync(manifestAbs, "utf8"));
  // The tracked manifest carries PUBLIC items only (no values, no filenames,
  // no private identifiers) — the private item is reduced to a bare count.
  assert.ok(!fs.readFileSync(manifestAbs, "utf8").includes("SENSITIVEVAL"));
  assert.equal(trackedManifest.queued.length, 1);
  assert.match(trackedManifest.queued[0].claim_id, /^clm-fix-/);
  assert.equal(trackedManifest.private_queued_count, 1);
  // The tracked manifest must not name the private entity/target or source file.
  const trackedText = fs.readFileSync(manifestAbs, "utf8");
  assert.ok(!trackedText.includes("vehicle-sedan-01"));
  assert.ok(!trackedText.includes("obs1.jsonl"));
  // Private identifiers/targets/filenames live only in the git-excluded
  // private detailed manifest.
  const privManifestAbs = path.join(dir, "private", "runtime", "runs", path.basename(res.runManifestPath));
  assert.ok(fs.existsSync(privManifestAbs));
  const privManifest = JSON.parse(fs.readFileSync(privManifestAbs, "utf8"));
  assert.equal(privManifest.private_queued.length, 1);
  assert.equal(privManifest.private_queued[0].target, path.join("private", "claims", "vehicle-sedan-01.jsonl"));
  assert.deepEqual(privManifest.observed_files, ["obs1.jsonl"]);
});

// --- ratify (human gate) ---
test("planRatify/applyRatify promote queued claims into canon and clear the queue", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "private/entities/sedan.md", entityFile("vehicle:sedan-01", "restricted"));
  observe(dir, "obs1.jsonl", [
    obsClaim({ id_domain: "fix", predicate: "p1", value: "v1" }),
    obsClaim({ id_domain: "sedan", entity: "vehicle:sedan-01", predicate: "p2", value: "v2", classification: "restricted" }),
  ]);
  applySync(dir, planSync(dir, { now: "2026-07-15T00:00:00Z" }), { now: "2026-07-15T00:00:00.000Z" });

  const plan = planRatify(dir, { all: true });
  assert.equal(plan.promote.length, 2);
  const { appended } = applyRatify(dir, plan, { now: "2026-07-15T01:00:00Z" });
  assert.equal(appended.length, 2);

  const fixLog = fs.readFileSync(path.join(dir, "claims", "organization-fix.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(fixLog.length, 2); // original + promoted
  assert.equal(JSON.parse(fixLog[1]).predicate, "p1");
  const sedanLog = fs.readFileSync(path.join(dir, "private", "claims", "vehicle-sedan-01.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(JSON.parse(sedanLog[0]).predicate, "p2");

  assert.equal(loadQueue(dir).length, 0);
  for (const [, e] of loadLedger(dir)) assert.equal(e.status, "ratified");
});

test("applyRatify --discard removes from queue without touching canon", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({ predicate: "p1", value: "v1" })]);
  applySync(dir, planSync(dir, { now: "2026-07-15T00:00:00Z" }), { now: "2026-07-15T00:00:00.000Z" });
  const before = fs.readFileSync(path.join(dir, "claims", "organization-fix.jsonl"), "utf8");

  const { appended, discarded } = applyRatify(dir, planRatify(dir, { all: true }), { discard: true, now: "2026-07-15T02:00:00Z" });
  assert.equal(appended.length, 0);
  assert.equal(discarded, 1);
  assert.equal(fs.readFileSync(path.join(dir, "claims", "organization-fix.jsonl"), "utf8"), before); // canon untouched
  assert.equal(loadQueue(dir).length, 0);
  for (const [, e] of loadLedger(dir)) assert.equal(e.status, "discarded");
});

test("planRatify --id selects a subset and reports unknown ids", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [
    obsClaim({ predicate: "p1", value: "v1" }),
    obsClaim({ predicate: "p2", value: "v2" }),
  ]);
  applySync(dir, planSync(dir, { now: "2026-07-15T00:00:00Z" }), { now: "2026-07-15T00:00:00.000Z" });

  const plan = planRatify(dir, { ids: ["clm-fix-0002"] });
  assert.equal(plan.promote.length, 1);
  assert.equal(plan.promote[0].claim.id, "clm-fix-0002");
  const bad = planRatify(dir, { ids: ["clm-nope-9999"] });
  assert.equal(bad.promote.length, 0);
  assert.ok(bad.problems.some((p) => /not found/.test(p.msg)));
});

// --- hardening: idempotency, crash-recovery, corruption, concurrency ---

test("candidateHash distinguishes retraction state (retracted_at is in the hash)", () => {
  const base = obsClaim();
  delete base.id_domain;
  const live = candidateHash({ ...base, retracted_at: null });
  const dead = candidateHash({ ...base, retracted_at: "2026-08-01T00:00:00Z" });
  assert.notEqual(live, dead);
});

test("evaluateCandidate rejects an externally-supplied claim id that already exists in canon", () => {
  const dir = tmpDir();
  seedStore(dir); // canon already has clm-fix-0001
  observe(dir, "obs1.jsonl", [obsClaim({ id: "clm-fix-0001", predicate: "dup", value: "x" })]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan.queued.length, 0);
  assert.ok(plan.problems.some((p) => /duplicate claim id/.test(p.msg)));
});

test("applySync apply-time idempotency: a crash-replayed plan does not double-queue", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({ predicate: "p1", value: "v1" })]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan.queued.length, 1);
  // First apply enqueues; replaying the SAME plan object (as a crash-retry
  // would) must be a no-op because the obs_id is already in the ledger/queue.
  const first = applySync(dir, plan, { now: "2026-07-15T00:00:00.000Z" });
  assert.equal(first.queuedCount, 1);
  const second = applySync(dir, plan, { now: "2026-07-15T00:00:01.000Z" });
  assert.equal(second.queuedCount, 0);
  assert.equal(loadQueue(dir).length, 1);
});

test("applyRatify is idempotent by claim id (crash after canon append, before queue removal)", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({ predicate: "p1", value: "v1" })]);
  applySync(dir, planSync(dir, { now: "2026-07-15T00:00:00Z" }), { now: "2026-07-15T00:00:00.000Z" });
  const plan = planRatify(dir, { all: true });
  const claimId = plan.promote[0].claim.id;

  // Simulate a prior ratification that appended to canon but crashed before
  // clearing the queue: pre-append the exact claim to its canon log.
  const canonAbs = path.join(dir, "claims", "organization-fix.jsonl");
  fs.appendFileSync(canonAbs, JSON.stringify(plan.promote[0].claim) + "\n");
  const linesBefore = fs.readFileSync(canonAbs, "utf8").trim().split(/\r?\n/).length;

  const res = applyRatify(dir, plan, { now: "2026-07-15T01:00:00Z" });
  assert.equal(res.alreadyCanon, 1);       // detected, not re-appended
  assert.equal(res.appended.length, 0);
  const linesAfter = fs.readFileSync(canonAbs, "utf8").trim().split(/\r?\n/).length;
  assert.equal(linesAfter, linesBefore);   // canon not double-appended
  assert.equal(loadQueue(dir).length, 0);  // queue still reconciled
  assert.ok(fs.readFileSync(canonAbs, "utf8").split(claimId).length - 1 === 1); // exactly one copy
});

test("loadQueue/loadLedger throw loudly on a corrupt operational line (never silently skip)", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({ predicate: "p1", value: "v1" })]);
  applySync(dir, planSync(dir, { now: "2026-07-15T00:00:00Z" }), { now: "2026-07-15T00:00:00.000Z" });
  const qp = path.join(dir, "runtime", "ratification-queue.jsonl");
  fs.appendFileSync(qp, "{ this is not valid json\n");
  assert.throws(() => loadQueue(dir), /corrupt operational JSONL/);
});

// --- triage (queue surfacing / bucketing) ---
const RECENT_TS = "2026-07-13T00:00:00Z"; // 1d before runner-test TODAY (2026-07-14)

function qentry(claim, over = {}) {
  return {
    obs_id: "obs-" + claim.id,
    claim,
    target: PRIVATE_CLASSES_TEST.has(claim.classification)
      ? path.join("private", "claims", claim.entity.replace(/:/g, "-") + ".jsonl")
      : path.join("claims", claim.entity.replace(/:/g, "-") + ".jsonl"),
    private: PRIVATE_CLASSES_TEST.has(claim.classification),
    source_file: "obs.jsonl", line: 1, queued_at: RECENT_TS,
    ...over,
  };
}
const PRIVATE_CLASSES_TEST = new Set(["restricted", "sensitive"]);
function enqueue(dir, entries) {
  const pub = entries.filter((e) => !e.private);
  const prv = entries.filter((e) => e.private);
  if (pub.length) write(dir, path.join("runtime", "ratification-queue.jsonl"), pub.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (prv.length) write(dir, path.join("private", "runtime", "ratification-queue.jsonl"), prv.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("triageBucket: restricted/sensitive -> privacy-hold (even if unresolved or conflicting)", () => {
  assert.equal(triageBucket(claim({ classification: "restricted", confidence: "unresolved" }), [], TODAY), "privacy-hold");
  assert.equal(triageBucket(claim({ classification: "sensitive" }), [], TODAY), "privacy-hold");
});

test("triageBucket is fail-closed: missing/unknown classification -> privacy-hold", () => {
  for (const cls of [null, undefined, "", "secret", "internal"]) {
    assert.equal(triageBucket(claim({ classification: cls }), [], TODAY), "privacy-hold",
      `classification ${JSON.stringify(cls)} must be held`);
  }
});

test("triageBucket: unresolved (non-private) -> needs-clarification, outranking a contradiction", () => {
  const canon = [claim({ id: "clm-fix-0001", value: "blue", asserted_at: RECENT_TS })];
  const q = claim({ id: "clm-fix-0002", value: "green", confidence: "unresolved", asserted_at: RECENT_TS });
  assert.equal(triageBucket(q, canon, TODAY), "needs-clarification");
});

test("triageBucket: would-conflict-with-canon -> contradiction", () => {
  const canon = [claim({ id: "clm-fix-0001", value: "blue", asserted_at: RECENT_TS })];
  const q = claim({ id: "clm-fix-0002", value: "green", asserted_at: RECENT_TS });
  assert.equal(triageBucket(q, canon, TODAY), "contradiction");
});

test("triageBucket: clean, no conflict -> ready", () => {
  assert.equal(triageBucket(claim({ predicate: "year", value: "2019", asserted_at: RECENT_TS }), [], TODAY), "ready");
});

test("triageQueue sorts the pending queue into all four buckets", () => {
  const dir = tmpDir();
  seedStore(dir); // canon: organization:fix color=blue (confirmed)
  write(dir, "private/entities/sedan.md", entityFile("vehicle:sedan-01", "restricted"));
  enqueue(dir, [
    qentry(claim({ id: "clm-fix-0010", predicate: "year", value: "2019", asserted_at: RECENT_TS })),        // ready
    qentry(claim({ id: "clm-fix-0011", predicate: "color", value: "green", asserted_at: RECENT_TS })),       // contradiction (vs canon blue)
    qentry(claim({ id: "clm-fix-0012", predicate: "status", value: "unknown", confidence: "unresolved", asserted_at: RECENT_TS })), // needs-clarification
    qentry(claim({ id: "clm-fix-0013", entity: "vehicle:sedan-01", predicate: "vin", value: "x", classification: "restricted", asserted_at: RECENT_TS })), // privacy-hold
  ]);
  const b = triageQueue(dir, { today: TODAY });
  assert.equal(b.ready.length, 1);
  assert.equal(b.contradiction.length, 1);
  assert.equal(b["needs-clarification"].length, 1);
  assert.equal(b["privacy-hold"].length, 1);
  assert.deepEqual(TRIAGE_BUCKETS, ["privacy-hold", "needs-clarification", "contradiction", "ready"]);
});

// --- delegated ratification (Axiom 18) ---
test("classAtOrBelow respects the public<personal<sensitive<restricted scale; unknown fails closed", () => {
  assert.equal(classAtOrBelow("public", "personal"), true);
  assert.equal(classAtOrBelow("personal", "personal"), true);
  assert.equal(classAtOrBelow("restricted", "public"), false);
  assert.equal(classAtOrBelow("bogus", "public"), false);
});

test("DEFAULT_RATIFY_POLICY is the safe floor: zero automation", () => {
  assert.equal(DEFAULT_RATIFY_POLICY.autoRatifyReady, false);
  const dir = tmpDir();
  seedStore(dir);
  enqueue(dir, [qentry(claim({ id: "clm-fix-0010", predicate: "year", value: "2019", asserted_at: RECENT_TS }))]);
  const plan = planAutoRatify(dir, { today: TODAY, now: RECENT_TS });
  assert.equal(plan.autoRatify.length, 0);        // nothing auto-promoted by default
  assert.equal(plan.surfaced.length, 1);          // everything surfaced for the human
  assert.equal(plan.surfaced[0].bucket, "ready");
});

test("planAutoRatify auto-promotes the ready bucket only when policy enables it and class is at/below the ceiling", () => {
  const dir = tmpDir();
  seedStore(dir);
  enqueue(dir, [
    qentry(claim({ id: "clm-fix-0010", predicate: "year", value: "2019", classification: "public", asserted_at: RECENT_TS })),
    qentry(claim({ id: "clm-fix-0011", predicate: "trim", value: "LX", classification: "personal", asserted_at: RECENT_TS })),
  ]);
  const plan = planAutoRatify(dir, { today: TODAY, now: RECENT_TS, policy: { autoRatifyReady: true, classificationCeiling: "public" } });
  assert.deepEqual(plan.autoRatify.map((q) => q.claim.id), ["clm-fix-0010"]); // public promoted
  assert.ok(plan.surfaced.some((s) => s.entry.claim.id === "clm-fix-0011"));  // personal above ceiling -> surfaced
});

test("planAutoRatify HARD-excludes privacy-hold and needs-clarification even under an aggressive policy", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "private/entities/sedan.md", entityFile("vehicle:sedan-01", "restricted"));
  enqueue(dir, [
    qentry(claim({ id: "clm-fix-0012", predicate: "status", value: "unknown", confidence: "unresolved", asserted_at: RECENT_TS })),
    qentry(claim({ id: "clm-fix-0013", entity: "vehicle:sedan-01", predicate: "vin", value: "x", classification: "restricted", asserted_at: RECENT_TS })),
  ]);
  const plan = planAutoRatify(dir, { today: TODAY, now: RECENT_TS, policy: { autoRatifyReady: true, classificationCeiling: "restricted" } });
  assert.equal(plan.autoRatify.length, 0); // neither is auto-ratified
  const buckets = plan.surfaced.map((s) => s.bucket).sort();
  assert.deepEqual(buckets, ["needs-clarification", "privacy-hold"]);
});

test("decisiveResolution flags a >=N:1 distinct-source win and abstains otherwise", () => {
  const green = ["s1", "s2", "s3"].map((s, i) => claim({ id: "g" + i, value: "green", source: s }));
  const blue = [claim({ id: "b0", value: "blue", source: "s9" })];
  const d = decisiveResolution([...green, ...blue], 3);
  assert.equal(d.decisive, true);
  assert.equal(d.winningValue, "green");
  const d2 = decisiveResolution([claim({ id: "g", value: "green", source: "s1" }), claim({ id: "g2", value: "green", source: "s2" }), ...blue], 3);
  assert.equal(d2.decisive, false); // 2:1 does not meet 3:1
});

test("decisiveResolution abstains when there is only one distinct value (agreement, not conflict)", () => {
  const d = decisiveResolution([claim({ id: "a", value: "green", source: "s1" }), claim({ id: "b", value: "green", source: "s2" })], 3);
  assert.equal(d.decisive, false);
  assert.match(d.reason, /one distinct value/);
});

test("planAutoRatify surfaces an evidence-decisive contradiction as ADVISORY (resolvable), never auto-written", () => {
  const dir = tmpDir();
  // Canon already holds 3 independently-sourced 'green' claims on the predicate.
  write(dir, "entities/fix.md", entityFile("organization:fix", "public", "Fix Co"));
  write(dir, "claims/organization-fix.jsonl",
    ["s1", "s2", "s3"].map((s, i) => JSON.stringify(claim({ id: "clm-fix-000" + (i + 1), predicate: "hue", value: "green", source: s, asserted_at: RECENT_TS }))).join("\n") + "\n");
  // A lone 'blue' claim is queued -> contradiction, but evidence is 3:1 for green.
  enqueue(dir, [qentry(claim({ id: "clm-fix-0020", predicate: "hue", value: "blue", source: "s9", asserted_at: RECENT_TS }))]);
  const plan = planAutoRatify(dir, { today: TODAY, now: RECENT_TS, policy: { decisiveSourceRatio: 3 } });
  assert.equal(plan.resolvable.length, 1);
  assert.equal(plan.resolvable[0].decision.winningValue, "green");
  assert.equal(plan.autoRatify.length, 0);          // NOT auto-written
  const canonAfter = fs.readFileSync(path.join(dir, "claims", "organization-fix.jsonl"), "utf8");
  assert.equal(canonAfter.split("clm-fix-0020").length - 1, 0); // queued claim never entered canon
});

test("applyAutoRatify promotes only the ready autoRatify set into canon and writes an audit log", () => {
  const dir = tmpDir();
  seedStore(dir);
  enqueue(dir, [qentry(claim({ id: "clm-fix-0010", predicate: "year", value: "2019", classification: "public", asserted_at: RECENT_TS }))]);
  const plan = planAutoRatify(dir, { today: TODAY, now: RECENT_TS, policy: { autoRatifyReady: true, classificationCeiling: "public" } });
  const res = applyAutoRatify(dir, plan);
  assert.equal(res.appended.length, 1);
  assert.equal(loadQueue(dir).length, 0); // promoted item cleared from queue
  const canon = fs.readFileSync(path.join(dir, "claims", "organization-fix.jsonl"), "utf8");
  assert.ok(canon.includes("clm-fix-0010"));
  const auditPath = path.join(dir, "runtime", "delegated-audit.jsonl");
  assert.ok(fs.existsSync(auditPath));
  const audit = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.ok(audit.some((a) => a.claim_id === "clm-fix-0010" && a.action === "auto-ratify"));
});


// --- retract (Axiom 24) ---
function readClaimsFile(dir, rel) {
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readFileSync(abs, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("planRetract targets an active claim; problems for missing/superseded/already-retracted", () => {
  const dir = tmpDir();
  seedStore(dir); // one active claim clm-fix-0001
  // add a superseded claim + its superseder, and an already-retracted claim
  const extra = [
    claim({ id: "clm-fix-0002", predicate: "size", value: "S" }),
    claim({ id: "clm-fix-0003", predicate: "size", value: "M", supersedes: "clm-fix-0002" }),
    claim({ id: "clm-fix-0004", predicate: "shape", value: "round", retracted_at: "2026-05-01T00:00:00Z", retraction_reason: "old" }),
  ];
  fs.appendFileSync(path.join(dir, "claims/organization-fix.jsonl"), extra.map((c) => JSON.stringify(c)).join("\n") + "\n");

  const plan = planRetract(dir, { ids: ["clm-fix-0001", "clm-fix-0002", "clm-fix-0004", "clm-nope-9999"], today: TODAY });
  assert.deepEqual(plan.retract.map((r) => r.claim.id), ["clm-fix-0001"]);
  const byId = Object.fromEntries(plan.problems.map((p) => [p.id, p.msg]));
  assert.match(byId["clm-fix-0002"], /not active/);
  assert.match(byId["clm-fix-0004"], /already retracted/);
  assert.match(byId["clm-nope-9999"], /not found/);
});

test("applyRetract sets retracted_at + retraction_reason in place and audits", () => {
  const dir = tmpDir();
  seedStore(dir);
  const plan = planRetract(dir, { ids: ["clm-fix-0001"], today: TODAY });
  const { retracted } = applyRetract(dir, plan, { now: "2026-07-14T12:00:00Z", reason: "misheard the color" });
  assert.deepEqual(retracted.map((r) => r.id), ["clm-fix-0001"]);
  const c = readClaimsFile(dir, "claims/organization-fix.jsonl").find((x) => x.id === "clm-fix-0001");
  assert.equal(c.retracted_at, "2026-07-14T12:00:00Z");
  assert.equal(c.retraction_reason, "misheard the color");
  // audit routed to public runtime (personal claim -> public partition)
  const audit = readClaimsFile(dir, "runtime/delegated-audit.jsonl");
  assert.ok(audit.some((a) => a.claim_id === "clm-fix-0001" && a.action === "retract" && a.reason === "misheard the color"));
});

test("applyRetract requires a non-empty reason", () => {
  const dir = tmpDir();
  seedStore(dir);
  const plan = planRetract(dir, { ids: ["clm-fix-0001"], today: TODAY });
  assert.throws(() => applyRetract(dir, plan, { reason: "" }), /reason/);
});

test("a retracted claim drops out of the active set (classify honors retracted_at)", () => {
  const dir = tmpDir();
  seedStore(dir);
  const before = assembleContext(dir, { today: TODAY }).markdown;
  assert.ok(before.includes("blue"));
  applyRetract(dir, planRetract(dir, { ids: ["clm-fix-0001"], today: TODAY }), { now: "2026-07-14T12:00:00Z", reason: "wrong" });
  const after = assembleContext(dir, { today: TODAY }).markdown;
  assert.ok(!after.includes("blue"));
});

// --- dead-letter (rt-dead-letter) ---
test("planSync: a poison record no longer blocks clean candidates; both are separated", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [
    obsClaim({ predicate: "good", value: "v1" }),        // clean
    "{ this is not json",                                   // malformed -> dead-letter
    obsClaim({ predicate: "bad", value: "v2", entity: "organization:ghost" }), // missing entity -> dead-letter
  ]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan.queued.length, 1);                    // the clean one still queues
  assert.equal(plan.deadLetters.length, 2);               // two poison lines set aside
  assert.ok(plan.problems.length >= 2);
});

test("applyDeadLetter writes PRIVATE-only records and is idempotent by dl_key", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", ["{ not json"]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  const r1 = applyDeadLetter(dir, plan.deadLetters, { now: "2026-07-15T00:00:00Z" });
  assert.equal(r1.quarantined, 1);
  // routed to private/, never tracked
  assert.ok(fs.existsSync(path.join(dir, "private", "runtime", "dead-letter.jsonl")));
  assert.ok(!fs.existsSync(path.join(dir, "runtime", "dead-letter.jsonl")));
  // re-applying the same dead-letters is a no-op (idempotent)
  const r2 = applyDeadLetter(dir, plan.deadLetters, { now: "2026-07-15T00:00:01Z" });
  assert.equal(r2.quarantined, 0);
});

test("a quarantined line is skipped on subsequent syncs (no re-flood, unattended progress)", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", ["{ not json", JSON.stringify(obsClaim({ predicate: "good", value: "v1" }))]);
  const plan1 = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan1.deadLetters.length, 1);
  applyDeadLetter(dir, plan1.deadLetters, { now: "2026-07-15T00:00:00Z" });
  applySync(dir, plan1, { now: "2026-07-15T00:00:00Z" });
  // second run: the poison line is now recognized and skipped, not re-failed
  const plan2 = planSync(dir, { now: "2026-07-15T00:00:02Z" });
  assert.equal(plan2.deadLetters.length, 0);
  assert.equal(plan2.problems.length, 0);
  assert.equal(plan2.quarantinedSkipped, 1);
});

test("deadLetterKey is stable for identical text and differs when the line is edited", () => {
  assert.equal(deadLetterKey("{ bad"), deadLetterKey("{ bad"));
  assert.notEqual(deadLetterKey("{ bad"), deadLetterKey("{ bad fixed"));
  assert.match(deadLetterKey("x"), /^dl-[0-9a-f]{32}$/);
});

test("loadDeadLetter reflects written quarantine keys", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", ["{ nope"]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  applyDeadLetter(dir, plan.deadLetters, { now: "2026-07-15T00:00:00Z" });
  const keys = loadDeadLetter(dir);
  assert.equal(keys.size, 1);
  assert.ok(keys.has(plan.deadLetters[0].dl_key));
});

// --- runtime schema versioning (rt-schema-versioning) ---
test("readSchemaVersion: fresh store is current; in-use store without a marker is legacy (0)", () => {
  const dir = tmpDir();
  seedStore(dir);
  assert.equal(readSchemaVersion(dir), RUNTIME_SCHEMA_VERSION); // no runtime files yet
  write(dir, "runtime/ledger.jsonl", JSON.stringify({ obs_id: "obs-x", status: "queued" }) + "\n");
  assert.equal(readSchemaVersion(dir), 0);                      // in use, no marker -> legacy
});

test("ensureSchema stamps a fresh store and migrates a legacy store to current", () => {
  const fresh = tmpDir();
  seedStore(fresh);
  const r1 = ensureSchema(fresh, { now: "2026-07-15T00:00:00Z" });
  assert.deepEqual([r1.from, r1.to, r1.migrated], [RUNTIME_SCHEMA_VERSION, RUNTIME_SCHEMA_VERSION, false]);
  assert.ok(fs.existsSync(path.join(fresh, "runtime", "schema.json")));

  const legacy = tmpDir();
  seedStore(legacy);
  write(legacy, "runtime/ledger.jsonl", JSON.stringify({ obs_id: "obs-x", status: "queued" }) + "\n");
  const r2 = ensureSchema(legacy, { now: "2026-07-15T00:00:00Z" });
  assert.deepEqual([r2.from, r2.to, r2.migrated], [0, RUNTIME_SCHEMA_VERSION, true]);
  assert.equal(readSchemaVersion(legacy), RUNTIME_SCHEMA_VERSION);
});

test("ensureSchema refuses a store written by a newer engine", () => {
  const dir = tmpDir();
  seedStore(dir);
  write(dir, "runtime/schema.json", JSON.stringify({ schema_version: RUNTIME_SCHEMA_VERSION + 1 }) + "\n");
  assert.throws(() => ensureSchema(dir), /newer than this engine/);
});

test("MIGRATIONS form a contiguous chain from 0 to the current version", () => {
  let v = 0;
  for (const m of MIGRATIONS) { assert.equal(m.from, v); v = m.to; }
  assert.equal(v, RUNTIME_SCHEMA_VERSION);
});

// --- recover: runtime state reconciliation (rt-recovery-reconcile) ---
function qEntry(over = {}) {
  return {
    obs_id: "obs-aaa",
    claim: claim({ id: "clm-fix-0001" }),
    target: "claims/organization-fix.jsonl",
    private: false,
    source_file: "inbox/observations/x.jsonl",
    line: 1,
    queued_at: "2026-07-15T00:00:00Z",
    ...over,
  };
}
function writeQueue(dir, entries, priv = false) {
  const rel = priv ? "private/runtime/ratification-queue.jsonl" : "runtime/ratification-queue.jsonl";
  write(dir, rel, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
function writeLedger(dir, entries, priv = false) {
  const rel = priv ? "private/runtime/ledger.jsonl" : "runtime/ledger.jsonl";
  write(dir, rel, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("recover: a store with only direct-capture canon reports info-only (no false alarms)", () => {
  const dir = tmpDir();
  seedStore(dir);
  const { findings } = planRecover(dir);
  assert.ok(findings.every((f) => f.severity === "info"), "no repairable/manual findings on a clean store");
  assert.ok(findings.some((f) => f.type === "ORPHAN_CANON" && f.claim_id === "clm-fix-0001"));
});

test("recover: duplicate obs_ids in the queue are detected and de-duplicated", () => {
  const dir = tmpDir();
  const q = qEntry({ obs_id: "obs-dup" });
  writeQueue(dir, [q, q]);
  const plan = planRecover(dir);
  const dup = plan.findings.find((f) => f.type === "DUPLICATE_OBS_IN_QUEUE");
  assert.ok(dup && dup.severity === "repairable");
  applyRecover(dir, planRecover(dir), { now: "2026-07-16T00:00:00Z" });
  assert.equal(loadQueue(dir).filter((e) => e.obs_id === "obs-dup").length, 1);
});

test("recover: a queued-then-ratified obs left in the queue is swept (STALE_QUEUE_ENTRY)", () => {
  const dir = tmpDir();
  writeQueue(dir, [qEntry({ obs_id: "obs-stale" })]);
  writeLedger(dir, [{ obs_id: "obs-stale", claim_id: "clm-fix-0001", status: "ratified", ratified_at: "2026-07-15T00:00:00Z" }]);
  const plan = planRecover(dir);
  assert.ok(plan.findings.some((f) => f.type === "STALE_QUEUE_ENTRY" && f.severity === "repairable"));
  applyRecover(dir, planRecover(dir), { now: "2026-07-16T00:00:00Z" });
  assert.equal(loadQueue(dir).some((e) => e.obs_id === "obs-stale"), false);
});

test("recover: a queue entry with no ledger record gets a reconciling 'queued' record (UNTRACKED_QUEUE)", () => {
  const dir = tmpDir();
  writeQueue(dir, [qEntry({ obs_id: "obs-untracked" })]);
  assert.ok(planRecover(dir).findings.some((f) => f.type === "UNTRACKED_QUEUE"));
  applyRecover(dir, planRecover(dir), { now: "2026-07-16T00:00:00Z" });
  const rec = loadLedger(dir).get("obs-untracked");
  assert.equal(rec.status, "queued");
  assert.equal(rec.reconciled, true);
  assert.equal(loadQueue(dir).length, 1, "queue entry is preserved, not removed");
});

test("recover: ledger stuck at 'queued' but claim already in canon is reconciled to 'ratified' (LEDGER_BEHIND_CANON)", () => {
  const dir = tmpDir();
  seedStore(dir); // canon has clm-fix-0001
  writeLedger(dir, [{ obs_id: "obs-behind", claim_id: "clm-fix-0001", status: "queued", first_seen: "2026-07-15T00:00:00Z" }]);
  assert.ok(planRecover(dir).findings.some((f) => f.type === "LEDGER_BEHIND_CANON"));
  applyRecover(dir, planRecover(dir), { now: "2026-07-16T00:00:00Z" });
  const rec = loadLedger(dir).get("obs-behind");
  assert.equal(rec.status, "ratified");
  assert.equal(rec.reconciled, true);
});

test("recover: a lost pending payload is flagged MANUAL and never auto-changed (LOST_QUEUED)", () => {
  const dir = tmpDir();
  writeLedger(dir, [{ obs_id: "obs-lost", claim_id: "clm-fix-9999", status: "queued", first_seen: "2026-07-15T00:00:00Z" }]);
  const f = planRecover(dir).findings.find((x) => x.type === "LOST_QUEUED");
  assert.ok(f && f.severity === "manual" && f.repair === null);
  const { applied } = applyRecover(dir, planRecover(dir), { now: "2026-07-16T00:00:00Z" });
  assert.equal(applied.some((a) => a.type === "LOST_QUEUED"), false);
});

test("recover: ledger ratified but claim absent from canon is flagged MANUAL (LOST_CANON)", () => {
  const dir = tmpDir();
  writeLedger(dir, [{ obs_id: "obs-gone", claim_id: "clm-fix-8888", status: "ratified", ratified_at: "2026-07-15T00:00:00Z" }]);
  const f = planRecover(dir).findings.find((x) => x.type === "LOST_CANON");
  assert.ok(f && f.severity === "manual");
});

test("recover: applyRecover only touches repairable findings, leaving canon untouched", () => {
  const dir = tmpDir();
  seedStore(dir);
  const canonBefore = fs.readFileSync(path.join(dir, "claims", "organization-fix.jsonl"), "utf8");
  writeQueue(dir, [qEntry({ obs_id: "obs-x" }), qEntry({ obs_id: "obs-x" })]);
  applyRecover(dir, planRecover(dir), { now: "2026-07-16T00:00:00Z" });
  assert.equal(fs.readFileSync(path.join(dir, "claims", "organization-fix.jsonl"), "utf8"), canonBefore);
});

// --- atomic observation publishing (rt-atomic-observe) ---
test("isObservationFile accepts only final, non-hidden, non-temp .jsonl names", () => {
  assert.equal(isObservationFile("batch.jsonl"), true);
  assert.equal(isObservationFile(".staging.jsonl"), false);
  assert.equal(isObservationFile("batch.jsonl.tmp-123"), false);
  assert.equal(isObservationFile("batch.jsonl.partial"), false);
  assert.equal(isObservationFile("batch.txt"), false);
  assert.equal(isObservationFile("batch.jsonl~"), false);
});

test("planSync scans only FINAL observation files, skipping in-progress drops", () => {
  const dir = tmpDir();
  seedStore(dir);
  const obs = path.join("inbox", "observations");
  write(dir, path.join(obs, "good.jsonl"), "{}\n");
  write(dir, path.join(obs, ".staging.jsonl"), "{ half-written");   // hidden staging
  write(dir, path.join(obs, "drop.jsonl.tmp-9"), "{ half-written"); // temp suffix
  write(dir, path.join(obs, "notes.txt"), "not an observation");
  const plan = planSync(dir, {});
  assert.deepEqual(plan.files, ["good.jsonl"]);
});

test("observationFiles returns sorted final files only", () => {
  const dir = tmpDir();
  const obs = path.join(dir, "inbox", "observations");
  fs.mkdirSync(obs, { recursive: true });
  for (const n of ["b.jsonl", "a.jsonl", ".x.jsonl", "c.jsonl.tmp-1"]) fs.writeFileSync(path.join(obs, n), "{}\n");
  assert.deepEqual(observationFiles(obs), ["a.jsonl", "b.jsonl"]);
});

test("publishObservation makes a drop appear atomically as a final .jsonl with no leftovers", () => {
  const dir = tmpDir();
  const obs = path.join(dir, "inbox", "observations");
  const p = publishObservation(obs, "batch.jsonl", '{"x":1}');
  assert.ok(fs.existsSync(p));
  assert.equal(fs.readFileSync(p, "utf8"), '{"x":1}\n');
  assert.deepEqual(fs.readdirSync(obs), ["batch.jsonl"]); // no temp/hidden leftovers
});

test("publishObservation appends a trailing newline only when missing", () => {
  const obs = path.join(tmpDir(), "obs");
  const p = publishObservation(obs, "a.jsonl", '{"x":1}\n');
  assert.equal(fs.readFileSync(p, "utf8"), '{"x":1}\n');
});

test("publishObservation rejects non-final names (must be a bare *.jsonl)", () => {
  const obs = path.join(tmpDir(), "obs");
  for (const bad of [".hidden.jsonl", "sub/dir.jsonl", "file.txt", "file.jsonl.tmp-1", "file.jsonl.partial"]) {
    assert.throws(() => publishObservation(obs, bad, "{}"), /bare final/);
  }
});

test("a published observation is consumed by planSync end-to-end", () => {
  const dir = tmpDir();
  seedStore(dir);
  const obs = path.join(dir, "inbox", "observations");
  const cand = obsClaim({ predicate: "founded", value: "2020" });
  publishObservation(obs, "drop.jsonl", JSON.stringify(cand));
  const plan = planSync(dir, {});
  assert.deepEqual(plan.files, ["drop.jsonl"]);
  assert.equal(plan.queued.length, 1);
});

// --- writer-lock mutual exclusion + cross-process contention (rt-crash-concurrency-tests) ---
function lockPath(dir) { return path.join(dir, "runtime", "writer.lock"); }
function plantLock(dir, over = {}) {
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  fs.writeFileSync(lockPath(dir), JSON.stringify({
    pid: process.pid, host: os.hostname(), acquired_at: new Date().toISOString(), cmd: "test", ...over,
  }));
}

test("withWriterLock serializes: a second acquire while held throws 'locked'", () => {
  const dir = tmpDir();
  seedStore(dir);
  const ran = withWriterLock(dir, () => {
    // Re-entering while the lock is held (same code path a 2nd writer hits) fails.
    assert.throws(() => withWriterLock(dir, () => "nope"), /locked by another writer/);
    return "ok";
  });
  assert.equal(ran, "ok");
});

test("withWriterLock releases the lock after success AND after a throw", () => {
  const dir = tmpDir();
  seedStore(dir);
  withWriterLock(dir, () => "done");
  assert.equal(fs.existsSync(lockPath(dir)), false, "released after success");
  assert.throws(() => withWriterLock(dir, () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(lockPath(dir)), false, "released after throw");
});

test("withWriterLock reclaims a STALE lock (old timestamp) and a DEAD-pid lock", () => {
  const stale = tmpDir(); seedStore(stale);
  plantLock(stale, { acquired_at: "2020-01-01T00:00:00Z" });        // ancient -> stale
  assert.equal(withWriterLock(stale, () => "reclaimed-stale"), "reclaimed-stale");

  const dead = tmpDir(); seedStore(dead);
  plantLock(dead, { pid: 2147483646 });                             // almost-certainly-dead pid
  assert.equal(withWriterLock(dead, () => "reclaimed-dead"), "reclaimed-dead");
});

test("cross-process: a live lock held by another process makes `sync --apply` refuse", () => {
  const dir = tmpDir();
  seedStore(dir);
  // Plant a FRESH lock owned by THIS (alive) process on THIS host: a child
  // running `sync --apply` must see it as held-and-not-stale and refuse.
  plantLock(dir);
  let code = 0, stderr = "";
  try {
    execFileSync(process.execPath, [RUNNER, "sync", "--apply"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status ?? 1;
    stderr = (e.stderr || "") + (e.stdout || "");
  }
  assert.notEqual(code, 0, "child must exit non-zero while the lock is held");
  assert.match(stderr, /locked by another writer/);
  // The planted lock is untouched (the child did not steal a live lock).
  assert.equal(fs.existsSync(lockPath(dir)), true);
});

test("privacy leak: a sensitive dead-lettered candidate never lands in a tracked file", () => {
  const dir = tmpDir();
  seedStore(dir);
  // A malformed observation line carrying sensitive text: the raw poison is
  // untrusted (we can't parse its classification) so it MUST be quarantined to
  // private/ only and never copied into any tracked (public) runtime file.
  observe(dir, "obs1.jsonl", ['{ "value": "LEAKCANARY-9876", broken json']);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan.deadLetters.length, 1, "malformed sensitive line must be dead-lettered");
  withWriterLock(dir, () => {
    applyDeadLetter(dir, plan.deadLetters, { now: "2026-07-15T00:00:00Z" });
    applySync(dir, plan, { now: "2026-07-15T00:00:00Z" });
  });
  // The canary IS captured — but ONLY under private/ (untracked).
  const priv = path.join(dir, "private", "runtime", "dead-letter.jsonl");
  assert.ok(fs.existsSync(priv) && fs.readFileSync(priv, "utf8").includes("LEAKCANARY"),
    "sensitive poison must be preserved privately for review");
  // Tracked (public) runtime tree must not contain the canary anywhere.
  const pubRuntime = path.join(dir, "runtime");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(pubRuntime)) {
    assert.ok(!fs.readFileSync(f, "utf8").includes("LEAKCANARY"), `canary leaked into tracked ${path.relative(dir, f)}`);
  }
});

// --- fact identity vs observation identity (rt-fact-vs-obs-identity) ---

test("factFingerprint ignores the observation envelope (source/note/confidence/asserted_at/retraction)", () => {
  const base = { entity: "person:x", predicate: "role", value: "founder", valid_from: "2020-01-01" };
  const a = factFingerprint({ ...base, source: "chatgpt", note: "n1", confidence: "high", asserted_at: "2026-01-01" });
  const b = factFingerprint({ ...base, source: "claude", note: "n2", confidence: "medium", asserted_at: "2026-07-14", retracted_at: "2026-08-01T00:00:00Z" });
  assert.equal(a, b, "same fact under different observation envelopes must share one fingerprint");
  assert.match(a, /^fact-[0-9a-f]{32}$/);
});

test("factFingerprint changes when the asserted fact changes (entity/predicate/value/validity)", () => {
  const base = { entity: "person:x", predicate: "role", value: "founder", valid_from: "2020-01-01", valid_to: null };
  const fp = factFingerprint(base);
  assert.notEqual(fp, factFingerprint({ ...base, entity: "person:y" }));
  assert.notEqual(fp, factFingerprint({ ...base, predicate: "title" }));
  assert.notEqual(fp, factFingerprint({ ...base, value: "advisor" }));
  assert.notEqual(fp, factFingerprint({ ...base, valid_from: "2021-01-01" }));
  assert.notEqual(fp, factFingerprint({ ...base, valid_to: "2025-01-01" }));
});

test("fact_fp and obs_id are independent identities (same fact, different capture)", () => {
  const f = { entity: "person:x", predicate: "role", value: "founder" };
  const o1 = candidateHash({ ...f, source: "chatgpt", note: "a" });
  const o2 = candidateHash({ ...f, source: "claude", note: "b" });
  assert.notEqual(o1, o2, "different envelopes -> different observation ids");
  assert.equal(factFingerprint({ ...f, source: "chatgpt" }), factFingerprint({ ...f, source: "claude" }),
    "...but the same underlying fact");
});

test("planSync labels a re-observation of a canon fact as 're-observed' (corroboration, not new)", () => {
  const dir = tmpDir();
  seedStore(dir); // canon holds clm-fix-0001: organization:fix / color / blue / valid_from 2026-01-01
  // Re-observe the SAME fact from a different source (distinct capture envelope).
  observe(dir, "obs1.jsonl", [obsClaim({
    entity: "organization:fix", predicate: "color", value: "blue", valid_from: "2026-01-01",
    source: "a-different-source", note: "restated",
  })]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan.queued.length, 1);
  assert.equal(plan.queued[0].evidence, "re-observed");
  assert.equal(plan.reobserved, 1);
});

test("planSync labels a genuinely different value as 'new-evidence'", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({
    entity: "organization:fix", predicate: "color", value: "green", valid_from: "2026-01-01",
  })]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan.queued[0].evidence, "new-evidence");
  assert.equal(plan.reobserved, 0);
});

test("two new observations of the same fact in one batch: first new, second re-observed", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [
    obsClaim({ entity: "organization:fix", predicate: "novel-pred", value: "V", source: "s1" }),
    obsClaim({ entity: "organization:fix", predicate: "novel-pred", value: "V", source: "s2" }),
  ]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  assert.equal(plan.queued.length, 2);
  assert.equal(plan.queued[0].evidence, "new-evidence");
  assert.equal(plan.queued[1].evidence, "re-observed");
});

test("applySync persists fact_fp and evidence into both the queue and the ledger", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({ entity: "organization:fix", predicate: "p9", value: "v9" })]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  applySync(dir, plan, { now: "2026-07-15T00:00:00Z" });
  const q = loadQueue(dir);
  assert.equal(q.length, 1);
  assert.match(q[0].fact_fp, /^fact-[0-9a-f]{32}$/);
  assert.equal(q[0].evidence, "new-evidence");
  const ledgerLine = fs.readFileSync(path.join(dir, "runtime", "ledger.jsonl"), "utf8").trim();
  assert.match(ledgerLine, /"fact_fp":"fact-/);
  assert.match(ledgerLine, /"evidence":"new-evidence"/);
});

// --- inbox archiving + soft backpressure (rt-queue-backpressure) ---

test("archiveProcessed moves a fully-processed inbox file out of the watched dir", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({ predicate: "p1", value: "v1" })]);
  applySync(dir, planSync(dir, { now: "2026-07-15T00:00:00Z" }), { now: "2026-07-15T00:00:00Z" });
  const res = archiveProcessed(dir, { now: "2026-07-15T00:00:00Z" });
  assert.deepEqual(res.archived, ["obs1.jsonl"]);
  // No longer visible to the consumer, so planSync stops rescanning it.
  assert.equal(observationFiles(path.join(dir, "inbox", "observations")).length, 0);
  // Moved (not deleted) into the git-excluded archive subdir.
  assert.ok(fs.existsSync(path.join(res.archiveDir, "obs1.jsonl")));
});

test("archiveProcessed also archives files whose only lines were dead-lettered", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "poison.jsonl", ["{ not json"]);
  const plan = planSync(dir, { now: "2026-07-15T00:00:00Z" });
  applyDeadLetter(dir, plan.deadLetters, { now: "2026-07-15T00:00:00Z" });
  const res = archiveProcessed(dir, { now: "2026-07-15T00:00:00Z" });
  assert.deepEqual(res.archived, ["poison.jsonl"]);
});

test("archiveProcessed leaves a file with an unprocessed line in place (no data loss)", () => {
  const dir = tmpDir();
  seedStore(dir);
  // First line is ingested; a SECOND line is appended after apply and never processed.
  observe(dir, "mix.jsonl", [obsClaim({ predicate: "p1", value: "v1" })]);
  applySync(dir, planSync(dir, { now: "2026-07-15T00:00:00Z" }), { now: "2026-07-15T00:00:00Z" });
  const abs = path.join(dir, "inbox", "observations", "mix.jsonl");
  fs.appendFileSync(abs, JSON.stringify(obsClaim({ predicate: "p2", value: "v2" })) + "\n");
  const res = archiveProcessed(dir, { now: "2026-07-15T00:00:01Z" });
  assert.equal(res.archived.length, 0, "file with an unresolved line must NOT be moved");
  assert.ok(fs.existsSync(abs), "the file (and its unprocessed line) stays put");
});

test("archived files are skipped by observationFiles (archive subdir is not rescanned)", () => {
  const dir = tmpDir();
  seedStore(dir);
  observe(dir, "obs1.jsonl", [obsClaim({ predicate: "p1", value: "v1" })]);
  applySync(dir, planSync(dir, { now: "2026-07-15T00:00:00Z" }), { now: "2026-07-15T00:00:00Z" });
  archiveProcessed(dir, { now: "2026-07-15T00:00:00Z" });
  // A fresh planSync sees nothing to do (archived file no longer rescanned).
  const plan2 = planSync(dir, { now: "2026-07-15T00:00:02Z" });
  assert.equal(plan2.queued.length, 0);
  assert.equal(plan2.duplicates.length, 0);
});

test("QUEUE_DEPTH_WARN is a positive soft threshold (never blocks ingestion)", () => {
  assert.ok(Number.isInteger(QUEUE_DEPTH_WARN) && QUEUE_DEPTH_WARN > 0);
});
