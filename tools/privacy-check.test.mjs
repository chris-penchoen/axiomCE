// Tests for the AxiomCE privacy guard. Node's built-in test runner only.
// Run with:  node --test "tools/*.test.mjs"
//
// No external services, no database, no network. The secret-like strings below
// are synthetic fixtures (documented AWS example key, standard test card
// number) — not real credentials.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  luhn,
  scanContent,
  scanSensitiveData,
  isGovernanceFile,
  privateExcludedByGitignore,
  checkFile,
  checkFiles,
  collectMarkdown,
  collectStructured,
} from "./privacy-check.mjs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-priv-"));
}
function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}
function fm(cls, body = "Body.") {
  return [
    "---",
    "title: Sample",
    "type: fact",
    `classification: ${cls}`,
    "updated: 2026-07-14",
    "---",
    "",
    body,
  ].join("\n");
}

// --- luhn ---
test("luhn accepts a valid test card and rejects a bad one", () => {
  assert.equal(luhn("4111111111111111"), true); // standard Visa test number
  assert.equal(luhn("4111111111111112"), false);
  assert.equal(luhn(""), false);
});

// --- scanContent: BLOCK signatures ---
test("scanContent blocks a private key block", () => {
  const r = scanContent("-----BEGIN RSA PRIVATE KEY-----\nabc\n");
  assert.ok(r.blocks.some((x) => x.includes("private key")));
});

test("scanContent blocks an AWS access key id", () => {
  const r = scanContent("aws = AKIAIOSFODNN7EXAMPLE");
  assert.ok(r.blocks.some((x) => x.includes("AWS access key")));
});

test("scanContent blocks a Luhn-valid card number", () => {
  const r = scanContent("card 4111111111111111 on file");
  assert.ok(r.blocks.some((x) => x.includes("card-like")));
});

test("scanContent blocks a hardcoded secret assignment", () => {
  const r = scanContent('api_key: "sk_live_abcdef1234567890"');
  assert.ok(r.blocks.some((x) => x.includes("hardcoded secret")));
});

// --- scanContent: no false positives ---
test("scanContent does not block prose mentioning password/secret", () => {
  const r = scanContent("Use your password manager for any secret or token.");
  assert.deepEqual(r.blocks, []);
});

test("scanContent ignores placeholder secret values", () => {
  const r = scanContent('password: <your-password-here>\ntoken = your-token-goes');
  assert.deepEqual(r.blocks, []);
});

// --- scanContent: WARN signatures ---
test("scanContent warns on an SSN-like pattern", () => {
  const r = scanContent("SSN 123-45-6789");
  assert.ok(r.warns.some((x) => x.includes("SSN")));
});

test("scanContent warns on a long non-Luhn digit run", () => {
  const r = scanContent("acct 1234567890123 maybe");
  assert.ok(r.warns.some((x) => x.includes("account number")));
});

// --- checkFile: classification placement ---
test("checkFile blocks a tracked restricted file", () => {
  const dir = tmpDir();
  const p = write(dir, "r.md", fm("restricted"));
  const r = checkFile(p);
  assert.ok(r.blocks.some((x) => x.includes("restricted")));
});

test("checkFile warns on a tracked sensitive file", () => {
  const dir = tmpDir();
  const p = write(dir, "s.md", fm("sensitive"));
  const r = checkFile(p);
  assert.ok(r.warns.some((x) => x.includes("sensitive")));
});

test("checkFile is clean for an ordinary personal file", () => {
  const dir = tmpDir();
  const p = write(dir, "ok.md", fm("personal"));
  const r = checkFile(p);
  assert.deepEqual(r.blocks, []);
  assert.deepEqual(r.warns, []);
});

test("checkFile does not block a restricted file under private/", () => {
  const dir = tmpDir();
  const p = write(dir, "private/r.md", fm("restricted"));
  const r = checkFile(p);
  assert.deepEqual(r.blocks, []);
});

// --- checkFiles / collectMarkdown ---
test("collectMarkdown skips private and node_modules", () => {
  const dir = tmpDir();
  write(dir, "a.md", fm("personal"));
  write(dir, "private/secret.md", fm("restricted"));
  write(dir, "node_modules/x.md", fm("personal"));
  const files = collectMarkdown(dir).map((f) => path.basename(f));
  assert.deepEqual(files, ["a.md"]);
});

test("checkFiles aggregates blocks and warns across files", () => {
  const dir = tmpDir();
  const a = write(dir, "a.md", fm("sensitive"));
  const b = write(dir, "b.md", 'token = "sk_live_abcdef1234567890"\n' + fm("personal"));
  const { blocks, warns } = checkFiles([a, b]);
  assert.ok(warns.length >= 1);
  assert.ok(blocks.length >= 1);
});

// --- scanSensitiveData: fires on real data tokens ---
test("scanSensitiveData flags a date of birth", () => {
  assert.ok(scanSensitiveData("Nova, born 2015-03-04, lives with dad").some((x) => x.includes("date-of-birth")));
});

test("scanSensitiveData flags an SSN", () => {
  assert.ok(scanSensitiveData("SSN 123-45-6789 on file").some((x) => x.includes("SSN")));
});

test("scanSensitiveData flags an exact salary figure", () => {
  assert.ok(scanSensitiveData("annual salary of $185,000 base").some((x) => x.includes("salary")));
});

test("scanSensitiveData flags custody-order language", () => {
  assert.ok(scanSensitiveData("per the custody order, weekends").some((x) => x.includes("custody-order")));
});

test("scanSensitiveData flags a medical diagnosis", () => {
  assert.ok(scanSensitiveData("diagnosed with a chronic condition").some((x) => x.includes("diagnosis")));
});

test("scanSensitiveData flags bankruptcy account detail (case word + amount)", () => {
  assert.ok(scanSensitiveData("Chapter 13 arrears of $4,200 owed").some((x) => x.includes("bankruptcy")));
});

test("scanSensitiveData flags an account number", () => {
  assert.ok(scanSensitiveData("account no. 000123456789 at bank").some((x) => x.includes("account number")));
});

// --- scanSensitiveData: conservative — topic words alone are clean ---
test("scanSensitiveData ignores bare topic words without data tokens", () => {
  assert.deepEqual(scanSensitiveData("Maintain Chapter 13 compliance; custody and trustee status pending."), []);
  assert.deepEqual(scanSensitiveData("single full-custody parent; arrears and trustee are open questions"), []);
  assert.deepEqual(scanSensitiveData("She is due to start school; birthday party planned."), []);
});

test("scanSensitiveData ignores placeholder dates and money-free pay mentions", () => {
  assert.deepEqual(scanSensitiveData("born <YYYY-MM-DD>; net pay not yet established; no comp $"), []);
});

// --- governance exemption ---
test("isGovernanceFile recognizes policy docs but not content files", () => {
  assert.equal(isGovernanceFile("/x/DATA_CLASSIFICATION.md"), true);
  assert.equal(isGovernanceFile("/x/PRIVATE_DATA.md"), true);
  assert.equal(isGovernanceFile("/x/family/nova.md"), false);
});

test("checkFile exempts governance docs from the heuristic scanner", () => {
  const dir = tmpDir();
  const body = "Never store: custody order, diagnosis, or account numbers.";
  const gov = write(dir, "DATA_CLASSIFICATION.md", fm("public", body));
  const content = write(dir, "note.md", fm("personal", body));
  assert.deepEqual(checkFile(gov).blocks, []);
  assert.ok(checkFile(content).blocks.length >= 1);
});

// --- gitignore guard ---
test("privateExcludedByGitignore detects a private/ exclusion", () => {
  assert.equal(privateExcludedByGitignore("# c\nprivate/\n!private/.gitkeep\n"), true);
  assert.equal(privateExcludedByGitignore("/private\nnode_modules/\n"), true);
  assert.equal(privateExcludedByGitignore("node_modules/\n*.tmp\n"), false);
});

test("the repo's own .gitignore excludes private/", () => {
  const gi = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  assert.equal(privateExcludedByGitignore(gi), true);
});

// --- integration: tracked repo must be clean ---
test("no tracked Markdown in the repo trips the privacy scanner", () => {
  const files = collectMarkdown(REPO_ROOT); // skips private/, node_modules
  const { blocks } = checkFiles(files);
  assert.deepEqual(
    blocks.map((b) => `${path.relative(REPO_ROOT, b.file)}: ${b.msg}`),
    []
  );
});

// --- structured files (.jsonl / .yaml) ---
function claim(overrides = {}) {
  return JSON.stringify({
    id: "clm-test-0001", entity: "vehicle:x", predicate: "color",
    value: "blue", confidence: "confirmed", classification: "public",
    valid_from: "2026-01-01", asserted_at: "2026-01-01T00:00:00Z",
    source: "test", ...overrides,
  });
}

test("checkFile blocks a restricted claim in a tracked .jsonl", () => {
  const dir = tmpDir();
  const p = write(dir, "claims/x.jsonl", claim({ classification: "restricted" }) + "\n");
  const r = checkFile(p);
  assert.ok(r.blocks.some((x) => x.includes("restricted claim")));
});

test("checkFile blocks sensitive data inside a tracked .jsonl value", () => {
  const dir = tmpDir();
  const p = write(dir, "claims/x.jsonl", claim({ value: "born 2015-03-04" }) + "\n");
  const r = checkFile(p);
  assert.ok(r.blocks.some((x) => x.includes("date-of-birth")));
});

test("checkFile is clean for an ordinary public claim", () => {
  const dir = tmpDir();
  const p = write(dir, "claims/x.jsonl", claim() + "\n");
  assert.deepEqual(checkFile(p).blocks, []);
});

test("checkFile ignores malformed .jsonl lines (validate-claims' job)", () => {
  const dir = tmpDir();
  const p = write(dir, "claims/x.jsonl", "{not json\n" + claim() + "\n");
  assert.deepEqual(checkFile(p).blocks, []);
});

test("checkFile does not treat a restricted claim under private/ as a leak", () => {
  const dir = tmpDir();
  const p = write(dir, "private/claims/x.jsonl", claim({ classification: "restricted", value: "born 2015-03-04" }) + "\n");
  assert.deepEqual(checkFile(p).blocks, []);
});

test("checkFile scans a tracked .yaml for sensitive data", () => {
  const dir = tmpDir();
  const p = write(dir, "kernel/x.yaml", "note: SSN 123-45-6789\n");
  assert.ok(checkFile(p).blocks.some((x) => x.includes("SSN")));
});

test("collectStructured gathers tracked .jsonl/.yaml but skips private and node_modules", () => {
  const dir = tmpDir();
  write(dir, "claims/a.jsonl", claim() + "\n");
  write(dir, "kernel/b.yaml", "k: v\n");
  write(dir, "private/claims/c.jsonl", claim() + "\n");
  write(dir, "node_modules/d.yaml", "k: v\n");
  const names = collectStructured(dir).map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ["a.jsonl", "b.yaml"]);
});

test("no tracked structured file in the repo trips the privacy scanner", () => {
  const files = collectStructured(REPO_ROOT);
  const { blocks } = checkFiles(files);
  assert.deepEqual(
    blocks.map((b) => `${path.relative(REPO_ROOT, b.file)}: ${b.msg}`),
    []
  );
});
