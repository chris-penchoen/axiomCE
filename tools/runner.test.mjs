// Tests for the AxiomCE continuity runner (project + capture + sync + ratify).
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
  candidateHash,
  loadLedger,
  loadQueue,
  planSync,
  applySync,
  planRatify,
  applyRatify,
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

