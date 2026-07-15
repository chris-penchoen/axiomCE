// Tests for the AxiomCE cognitive-model validator. Node's built-in runner only.
// Run with:  node --test "tools/*.test.mjs"
//
// No external services, no database, no network. All fixtures are synthetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractPolicyIds,
  extractRuleRefs,
  namespaceOf,
  validateCognitive,
  CM_ID_RE,
  CM_NAMESPACES,
} from "./validate-cognitive.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-cm-"));
}
function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}
function policyFile(rules) {
  const body = rules.map((r) => `### ${r} — title\n\nStatement.\n`).join("\n");
  return `---\ntitle: P\ntype: policy\nclassification: personal\nupdated: 2026-07-14\n---\n\n${body}`;
}
function caseFile(caseId, rules) {
  return [
    "---",
    "title: C",
    "type: calibration",
    "classification: personal",
    "updated: 2026-07-14",
    `case_id: ${caseId}`,
    `rules: [${rules.join(", ")}]`,
    "---",
    "",
    "Body.",
  ].join("\n");
}

test("CM_ID_RE accepts valid ids incl. sub-namespace", () => {
  assert.ok(CM_ID_RE.test("CM-DELIVERY-01"));
  assert.ok(CM_ID_RE.test("CM-OPT-AG-01"));
  assert.ok(!CM_ID_RE.test("CM-DELIVERY-1")); // needs >=2 digits
  assert.ok(!CM_ID_RE.test("cm-delivery-01")); // lowercase
});

test("namespaceOf returns the token after CM-", () => {
  assert.equal(namespaceOf("CM-OPT-AG-01"), "OPT");
  assert.equal(namespaceOf("CM-FRICTION-12"), "FRICTION");
});

test("extractPolicyIds collects valid ids and flags malformed", () => {
  const content = [
    "### CM-DELIVERY-01 — good",
    "### CM-OPT-AG-02 — good sub-namespace",
    "### CM-BOGUS-01 — unknown namespace",
    "### CM-DELIVERY-1 — too few digits",
    "#### CM-INTERACTION-03 — good h4",
    "## Not an id heading",
  ].join("\n");
  const { ids, malformed } = extractPolicyIds(content);
  assert.deepEqual(ids, ["CM-DELIVERY-01", "CM-OPT-AG-02", "CM-INTERACTION-03"]);
  assert.deepEqual(malformed.sort(), ["CM-BOGUS-01", "CM-DELIVERY-1"].sort());
});

test("extractPolicyIds ignores IDs inside code fences", () => {
  const content = "```\n### CM-DELIVERY-99 — fenced\n```\n### CM-DELIVERY-01 — real\n";
  const { ids } = extractPolicyIds(content);
  assert.deepEqual(ids, ["CM-DELIVERY-01"]);
});

test("extractRuleRefs pulls ids from a front-matter list string", () => {
  assert.deepEqual(
    extractRuleRefs("[CM-DELIVERY-02, CM-OPT-AG-01, CM-FRICTION-10]"),
    ["CM-DELIVERY-02", "CM-OPT-AG-01", "CM-FRICTION-10"]
  );
  assert.deepEqual(extractRuleRefs(""), []);
  assert.deepEqual(extractRuleRefs(undefined), []);
});

test("validateCognitive: clean fixture passes", () => {
  const dir = tmpDir();
  write(dir, "cognitive-model/policy/delivery-contract.md", policyFile(["CM-DELIVERY-01", "CM-DELIVERY-02"]));
  write(dir, "cognitive-model/calibration/cases/cm-cal-0001.md", caseFile("cm-cal-0001", ["CM-DELIVERY-01"]));
  const { problems, policyCount, caseCount } = validateCognitive(dir);
  assert.equal(problems.length, 0);
  assert.equal(policyCount, 2);
  assert.equal(caseCount, 1);
});

test("validateCognitive: duplicate policy id across files", () => {
  const dir = tmpDir();
  write(dir, "cognitive-model/policy/a.md", policyFile(["CM-DELIVERY-01"]));
  write(dir, "cognitive-model/policy/b.md", policyFile(["CM-DELIVERY-01"]));
  const { problems } = validateCognitive(dir);
  assert.ok(problems.some((p) => /duplicate policy id: CM-DELIVERY-01/.test(p.msg)));
});

test("validateCognitive: malformed policy id reported", () => {
  const dir = tmpDir();
  write(dir, "cognitive-model/policy/a.md", policyFile(["CM-DELIVERY-01"]) + "\n### CM-OOPS-1 — bad\n");
  const { problems } = validateCognitive(dir);
  assert.ok(problems.some((p) => /malformed policy id/.test(p.msg)));
});

test("validateCognitive: calibration cites missing policy id", () => {
  const dir = tmpDir();
  write(dir, "cognitive-model/policy/a.md", policyFile(["CM-DELIVERY-01"]));
  write(dir, "cognitive-model/calibration/cases/cm-cal-0001.md", caseFile("cm-cal-0001", ["CM-DELIVERY-99"]));
  const { problems } = validateCognitive(dir);
  assert.ok(problems.some((p) => /cites missing policy id: CM-DELIVERY-99/.test(p.msg)));
});

test("validateCognitive: case_id must match filename and be unique", () => {
  const dir = tmpDir();
  write(dir, "cognitive-model/policy/a.md", policyFile(["CM-DELIVERY-01"]));
  write(dir, "cognitive-model/calibration/cases/cm-cal-0001.md", caseFile("cm-cal-9999", ["CM-DELIVERY-01"]));
  const { problems } = validateCognitive(dir);
  assert.ok(problems.some((p) => /does not match filename/.test(p.msg)));
});

test("validateCognitive: case with no rules is flagged", () => {
  const dir = tmpDir();
  write(dir, "cognitive-model/policy/a.md", policyFile(["CM-DELIVERY-01"]));
  write(dir, "cognitive-model/calibration/cases/cm-cal-0001.md", caseFile("cm-cal-0001", []));
  const { problems } = validateCognitive(dir);
  assert.ok(problems.some((p) => /cites no policy rules/.test(p.msg)));
});

test("the real repository cognitive-model pillar is valid", () => {
  const { problems } = validateCognitive(REPO_ROOT);
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));
  assert.ok(CM_NAMESPACES.length === 5);
});
