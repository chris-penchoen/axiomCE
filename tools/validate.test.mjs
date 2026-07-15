// Tests for the AxiomCE engine validator. Uses only Node's built-in test runner.
// Run with:  node --test tools/
//
// No external services, no database, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseFrontMatter,
  extractRelativeLinks,
  extractBareRelativeLinks,
  stripCodeAndLinks,
  validateFile,
  validateTree,
  collectMarkdown,
  isTemplateFile,
  REQUIRED_KEYS,
  ALLOWED_CLASSIFICATIONS,
} from "./validate.mjs";

// --- helpers ---
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-test-"));
}
function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}
const GOOD_FM = [
  "---",
  "title: Sample",
  "type: fact",
  "classification: personal",
  "updated: 2026-07-14",
  "---",
  "",
  "Body.",
].join("\n");

// --- parseFrontMatter ---
test("parseFrontMatter reads a valid block", () => {
  const fm = parseFrontMatter(GOOD_FM);
  assert.equal(fm.found, true);
  assert.equal(fm.data.title, "Sample");
  assert.equal(fm.data.classification, "personal");
});

test("parseFrontMatter strips surrounding quotes", () => {
  const fm = parseFrontMatter('---\ntitle: "Quoted"\n---\n');
  assert.equal(fm.data.title, "Quoted");
});

test("parseFrontMatter returns not-found when no leading ---", () => {
  const fm = parseFrontMatter("# No front matter\n");
  assert.equal(fm.found, false);
});

test("parseFrontMatter returns not-found when unterminated", () => {
  const fm = parseFrontMatter("---\ntitle: X\nno closing delimiter\n");
  assert.equal(fm.found, false);
});

// --- extractRelativeLinks ---
test("extractRelativeLinks finds relative targets and drops fragments", () => {
  const md = "See [a](./a.md) and [b](../b.md#section).";
  assert.deepEqual(extractRelativeLinks(md), ["./a.md", "../b.md"]);
});

test("extractRelativeLinks ignores urls, mailto, anchors, absolute paths", () => {
  const md =
    "[x](https://e.com) [y](mailto:a@b.c) [z](#top) [w](/abs.md) [ok](rel.md)";
  assert.deepEqual(extractRelativeLinks(md), ["rel.md"]);
});

// --- validateFile ---
test("validateFile passes a well-formed file", () => {
  const dir = tmpDir();
  const p = write(dir, "ok.md", GOOD_FM);
  assert.deepEqual(validateFile(p), []);
});

test("validateFile flags missing front matter", () => {
  const dir = tmpDir();
  const p = write(dir, "bad.md", "# no front matter\n");
  const problems = validateFile(p);
  assert.ok(problems.some((x) => x.includes("front matter")));
});

test("validateFile flags each missing required key", () => {
  const dir = tmpDir();
  const p = write(dir, "partial.md", "---\ntitle: Only Title\n---\n");
  const problems = validateFile(p);
  for (const key of REQUIRED_KEYS.filter((k) => k !== "title")) {
    assert.ok(
      problems.some((x) => x.includes(key)),
      `expected a violation mentioning ${key}`
    );
  }
});

test("validateFile flags invalid classification", () => {
  const dir = tmpDir();
  const bad = GOOD_FM.replace("classification: personal", "classification: topsecret");
  const p = write(dir, "cls.md", bad);
  const problems = validateFile(p);
  assert.ok(problems.some((x) => x.includes("invalid classification")));
});

test("validateFile accepts every allowed classification", () => {
  const dir = tmpDir();
  for (const cls of ALLOWED_CLASSIFICATIONS) {
    const content = GOOD_FM.replace("classification: personal", `classification: ${cls}`);
    const p = write(dir, `cls-${cls}.md`, content);
    assert.deepEqual(validateFile(p), [], `classification ${cls} should be valid`);
  }
});

test("validateFile flags broken relative links", () => {
  const dir = tmpDir();
  const content = GOOD_FM + "\n\nSee [missing](./nope.md).\n";
  const p = write(dir, "link.md", content);
  const problems = validateFile(p);
  assert.ok(problems.some((x) => x.includes("broken relative link")));
});

test("validateFile accepts links that resolve", () => {
  const dir = tmpDir();
  write(dir, "target.md", GOOD_FM);
  const content = GOOD_FM + "\n\nSee [target](./target.md).\n";
  const p = write(dir, "source.md", content);
  assert.deepEqual(validateFile(p), []);
});

// --- bare relative references ---
test("extractBareRelativeLinks finds plain-text ./ and ../ md paths", () => {
  const md = "Related:\n- ../people/alex.md\n- ./events.md\n";
  assert.deepEqual(extractBareRelativeLinks(md), ["../people/alex.md", "./events.md"]);
});

test("extractBareRelativeLinks ignores code spans, fences, and markdown links", () => {
  const md = [
    "See [alex](../people/alex.md).", // markdown link — already checked elsewhere
    "Inline `../people/levi.md` mention.", // code span — illustrative
    "```",
    "../people/nope.md", // fenced code — illustrative
    "```",
  ].join("\n");
  assert.deepEqual(extractBareRelativeLinks(md), []);
});

test("extractBareRelativeLinks ignores bare filenames without ./ or ../", () => {
  const md = "See CURRENT_CONTEXT.md for details.";
  assert.deepEqual(extractBareRelativeLinks(md), []);
});

test("stripCodeAndLinks removes fences, inline code, and links", () => {
  const out = stripCodeAndLinks("a `b` [c](d.md) ```e``` f");
  assert.ok(!out.includes("b"));
  assert.ok(!out.includes("d.md"));
  assert.ok(out.includes("a"));
  assert.ok(out.includes("f"));
});

test("validateFile flags a broken bare relative reference", () => {
  const dir = tmpDir();
  const content = GOOD_FM + "\n\n## Related\n\n- ../nope/missing.md\n";
  const p = write(dir, "bare.md", content);
  const problems = validateFile(p);
  assert.ok(problems.some((x) => x.includes("broken bare relative reference")));
});

test("validateFile accepts a bare relative reference that resolves", () => {
  const dir = tmpDir();
  write(dir, "target.md", GOOD_FM);
  const content = GOOD_FM + "\n\n## Related\n\n- ./target.md\n";
  const p = write(dir, "source.md", content);
  assert.deepEqual(validateFile(p), []);
});

// --- date-format / placeholder checks ---
test("validateFile flags an unfilled placeholder date", () => {
  const dir = tmpDir();
  const bad = GOOD_FM.replace("updated: 2026-07-14", "updated: <YYYY-MM-DD>");
  const p = write(dir, "ph.md", bad);
  const problems = validateFile(p);
  assert.ok(
    problems.some((x) => x.includes("placeholder date") && x.includes("updated")),
    "expected an unfilled-placeholder violation for updated"
  );
});

test("validateFile flags a malformed date", () => {
  const dir = tmpDir();
  const bad = GOOD_FM.replace("updated: 2026-07-14", "updated: banana");
  const p = write(dir, "bad-date.md", bad);
  const problems = validateFile(p);
  assert.ok(
    problems.some((x) => x.includes("invalid date format") && x.includes("updated")),
    "expected an invalid-date-format violation for updated"
  );
});

test("validateFile checks the created date too when present", () => {
  const dir = tmpDir();
  const bad = GOOD_FM.replace(
    "updated: 2026-07-14",
    "updated: 2026-07-14\ncreated: <YYYY-MM-DD>"
  );
  const p = write(dir, "created-ph.md", bad);
  const problems = validateFile(p);
  assert.ok(problems.some((x) => x.includes("placeholder date") && x.includes("created")));
});

test("validateFile exempts template files from placeholder/date checks", () => {
  const dir = tmpDir();
  const tpl = GOOD_FM.replace("updated: 2026-07-14", "updated: <YYYY-MM-DD>");
  const p = write(dir, "tpl.md", tpl);
  assert.deepEqual(validateFile(p, { isTemplate: true }), []);
});

test("isTemplateFile treats templates/*.md as templates but not templates/README.md", () => {
  assert.equal(isTemplateFile(path.join("repo", "templates", "fact.md")), true);
  assert.equal(isTemplateFile(path.join("repo", "templates", "README.md")), false);
  assert.equal(isTemplateFile(path.join("repo", "finance", "income.md")), false);
});

test("validateTree exempts real template files but not templates/README.md", () => {
  const dir = tmpDir();
  const placeholder = GOOD_FM.replace("updated: 2026-07-14", "updated: <YYYY-MM-DD>");
  write(dir, "templates/fact.md", placeholder); // exempt → no violation
  write(dir, "templates/README.md", placeholder); // real index → must fail
  const { violations } = validateTree(dir);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].file.endsWith("README.md"));
});

// --- canonical inline confidence form ---
test("validateFile flags the non-canonical (confidence: <label>) form", () => {
  const dir = tmpDir();
  const content = GOOD_FM + "\n\nA claim (confidence: user-stated) here.\n";
  const p = write(dir, "conf.md", content);
  const problems = validateFile(p);
  assert.ok(problems.some((x) => x.includes("non-canonical inline confidence")));
});

test("validateFile accepts the canonical (<label>) form", () => {
  const dir = tmpDir();
  const content = GOOD_FM + "\n\nA claim (user-stated) and an (estimate: ±20%).\n";
  const p = write(dir, "conf-ok.md", content);
  assert.deepEqual(validateFile(p), []);
});

test("validateFile ignores (confidence: ...) inside code spans", () => {
  const dir = tmpDir();
  const content = GOOD_FM + "\n\nAvoid the `(confidence: user-stated)` form.\n";
  const p = write(dir, "conf-code.md", content);
  assert.deepEqual(validateFile(p), []);
});

// --- collectMarkdown / validateTree ---
test("collectMarkdown skips ignored directories", () => {
  const dir = tmpDir();
  write(dir, "a.md", GOOD_FM);
  write(dir, "private/secret.md", "# not walked");
  write(dir, "node_modules/x.md", "# not walked");
  const files = collectMarkdown(dir).map((f) => path.basename(f));
  assert.deepEqual(files, ["a.md"]);
});

test("validateTree aggregates violations across files", () => {
  const dir = tmpDir();
  write(dir, "good.md", GOOD_FM);
  write(dir, "bad.md", "# nope\n");
  const { files, violations } = validateTree(dir);
  assert.equal(files, 2);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].file.endsWith("bad.md"));
});
