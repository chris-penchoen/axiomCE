#!/usr/bin/env node
// AxiomCE Markdown validator — zero external dependencies.
//
// Checks, for every tracked Markdown file:
//   1. Front matter present (delimited by `---` on the first line and a later `---`).
//   2. Required front-matter keys present and non-empty: title, type,
//      classification, updated.
//   3. `classification` is one of the allowed values.
//   4. All *relative* Markdown links resolve to an existing file on disk.
//
// It deliberately parses only a small `key: value` subset of YAML — the subset
// AxiomCE templates use. No YAML library, no network, no database.
//
// Usage:
//   node tools/validate.mjs            # validate the repo (cwd or repo root)
//   node tools/validate.mjs <dir>      # validate a specific directory
//
// Exit code 0 = clean, 1 = violations found.

import fs from "node:fs";
import path from "node:path";

export const REQUIRED_KEYS = ["title", "type", "classification", "updated"];
export const ALLOWED_CLASSIFICATIONS = [
  "public",
  "personal",
  "sensitive",
  "restricted",
];

// Front-matter keys that must hold an ISO date (YYYY-MM-DD) in real files.
export const DATE_KEYS = ["updated", "created"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDER_RE = /<[^>]+>/; // e.g. <YYYY-MM-DD>

// Directories never walked.
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "private", // local-only, may contain untracked sensitive files
]);

/**
 * Parse a leading YAML front-matter block (a small key: value subset).
 * @param {string} content
 * @returns {{ found: boolean, data: Record<string,string>, endLine: number }}
 */
export function parseFrontMatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { found: false, data: {}, endLine: -1 };
  }
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { found: true, data, endLine: i };
    }
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) data[key] = value;
  }
  // No closing delimiter found.
  return { found: false, data: {}, endLine: -1 };
}

/**
 * Extract relative Markdown link targets from content.
 * Skips absolute URLs, mailto:, anchors (#...), and absolute paths.
 * Strips any #fragment from the target.
 * @param {string} content
 * @returns {string[]}
 */
export function extractRelativeLinks(content) {
  const targets = [];
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(content)) !== null) {
    let target = m[1].trim();
    // Strip optional title: [x](path "title")
    const sp = target.indexOf(" ");
    if (sp !== -1) target = target.slice(0, sp);
    if (!target) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:, etc.
    if (target.startsWith("#")) continue; // in-page anchor
    if (target.startsWith("/")) continue; // absolute path — out of scope
    target = target.split("#")[0]; // drop fragment
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Strip fenced code blocks, inline code spans, and Markdown link constructs
 * from content, so that bare-path detection only sees prose/list references.
 * @param {string} content
 * @returns {string}
 */
export function stripCodeAndLinks(content) {
  return content
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code spans
    .replace(/\[[^\]]*\]\([^)]*\)/g, " "); // [text](target) Markdown links
}

/**
 * Extract *bare* relative Markdown references — path tokens like `../x/y.md`
 * or `./z.md` that appear as plain text (e.g. in "## Related" lists), not as
 * Markdown links. Existing Markdown links, code spans, and fenced blocks are
 * excluded so illustrative prose does not false-positive. Only leading
 * `./`/`../` tokens are matched, to avoid catching bare filename mentions.
 * @param {string} content
 * @returns {string[]}
 */
export function extractBareRelativeLinks(content) {
  const stripped = stripCodeAndLinks(content);
  const re = /\.\.?\/[\w./-]*\.md/g;
  const out = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const target = m[0].split("#")[0];
    if (target) out.push(target);
  }
  return out;
}

/**
 * Validate a single Markdown file.
 * @param {string} filePath absolute path
 * @param {{ isTemplate?: boolean }} [options] `isTemplate` exempts a file from
 *   placeholder/date-format checks (template files legitimately hold `<...>`).
 * @returns {string[]} list of violation messages (empty = ok)
 */
export function validateFile(filePath, options = {}) {
  const { isTemplate = false } = options;
  const problems = [];
  const content = fs.readFileSync(filePath, "utf8");

  const fm = parseFrontMatter(content);
  if (!fm.found) {
    problems.push("missing or unterminated front matter (--- ... ---)");
  } else {
    for (const key of REQUIRED_KEYS) {
      if (!fm.data[key] || fm.data[key].length === 0) {
        problems.push(`missing required front-matter key: ${key}`);
      }
    }
    const cls = fm.data.classification;
    if (cls && !ALLOWED_CLASSIFICATIONS.includes(cls)) {
      problems.push(
        `invalid classification "${cls}" (allowed: ${ALLOWED_CLASSIFICATIONS.join(", ")})`
      );
    }
    // Date fields must be real ISO dates in non-template files. Templates are
    // allowed to keep `<YYYY-MM-DD>` placeholders.
    if (!isTemplate) {
      for (const key of DATE_KEYS) {
        const value = fm.data[key];
        if (value === undefined || value.length === 0) continue; // absence handled above (required keys) or allowed (optional)
        if (PLACEHOLDER_RE.test(value)) {
          problems.push(`unfilled placeholder date in "${key}": ${value}`);
        } else if (!ISO_DATE_RE.test(value)) {
          problems.push(`invalid date format in "${key}": "${value}" (expected YYYY-MM-DD)`);
        }
      }
    }
  }

  const dir = path.dirname(filePath);
  for (const link of extractRelativeLinks(content)) {
    const resolved = path.resolve(dir, link);
    if (!fs.existsSync(resolved)) {
      problems.push(`broken relative link: ${link}`);
    }
  }
  for (const ref of extractBareRelativeLinks(content)) {
    const resolved = path.resolve(dir, ref);
    if (!fs.existsSync(resolved)) {
      problems.push(`broken bare relative reference: ${ref}`);
    }
  }

  // Canonical inline confidence form is `(<label>)`, not `(confidence: <label>)`.
  // Code spans / fenced blocks are stripped so documentation examples are exempt.
  const CONFIDENCE_LABELS = "confirmed|user-stated|inferred|estimate|unresolved";
  const badConfidence = new RegExp(`\\(confidence:\\s*(?:${CONFIDENCE_LABELS})\\b`, "i");
  if (badConfidence.test(stripCodeAndLinks(content))) {
    problems.push(
      'non-canonical inline confidence "(confidence: <label>)" — use "(<label>)" (see CONVENTIONS.md)'
    );
  }

  return problems;
}

/**
 * Recursively collect .md files under a root, skipping IGNORED_DIRS.
 * @param {string} root
 * @returns {string[]}
 */
export function collectMarkdown(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Decide whether a file is a template (placeholders allowed). Template files
 * live under a `templates/` directory; a `README.md` there is a real index, not
 * a template, so it is NOT exempt.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isTemplateFile(filePath) {
  const segments = filePath.split(/[\\/]/);
  const inTemplates = segments.includes("templates");
  const isReadme = path.basename(filePath).toLowerCase() === "readme.md";
  return inTemplates && !isReadme;
}

/**
 * Validate a whole directory tree.
 * @param {string} root
 * @returns {{ files: number, violations: Array<{file: string, problems: string[]}> }}
 */
export function validateTree(root) {
  const files = collectMarkdown(root);
  const violations = [];
  for (const f of files) {
    const problems = validateFile(f, { isTemplate: isTemplateFile(f) });
    if (problems.length) violations.push({ file: f, problems });
  }
  return { files: files.length, violations };
}

// --- CLI entry point (only when run directly, not when imported) ---
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (isMain) {
  const root = path.resolve(process.argv[2] || ".");
  const { files, violations } = validateTree(root);
  if (violations.length === 0) {
    console.log(`OK — validated ${files} Markdown file(s), no problems.`);
    process.exit(0);
  }
  console.error(`FAIL — ${violations.length} of ${files} file(s) have problems:\n`);
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}`);
    for (const p of v.problems) console.error(`    - ${p}`);
  }
  process.exit(1);
}
