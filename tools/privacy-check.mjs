#!/usr/bin/env node
// AxiomCE privacy guard — zero external dependencies.
//
// Turns the documentation-only privacy model (PRIVATE_DATA.md,
// DATA_CLASSIFICATION.md) into an executable check. Intended to run manually or
// as a Git pre-commit hook so that Never-store secrets and mis-placed
// Restricted/Sensitive content cannot slip into a commit.
//
// Two severities:
//   BLOCK (exit 1) — Never-store secrets that must not exist in the repo at all,
//                    plus Restricted content in a tracked (non-private) file.
//   WARN  (exit 0) — Sensitive content tracked in Git (needs private-repo +
//                    opt-in per DATA_CLASSIFICATION.md), and probable ID/account
//                    numbers that likely belong in private/.
//
// Usage:
//   node tools/privacy-check.mjs                 # scan the repo (Markdown)
//   node tools/privacy-check.mjs <path> [...]    # scan specific files (hook mode)
//
// It never reads or writes network/database. private/ is skipped in tree scans.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseFrontMatter } from "./validate.mjs";

const IGNORED_DIRS = new Set([".git", "node_modules", "private"]);

// Governance / meta files necessarily *describe* the sensitive categories
// (custody, diagnoses, bankruptcy, account numbers, etc.) and carry format
// examples. Running the heuristic "actual-data" scanner over them produces
// guaranteed false positives, so they are exempt from that scanner only. The
// unambiguous secret scanner (scanContent: private keys, AWS keys, Luhn cards,
// secret assignments) STILL runs on them. Documented false-positive control.
const GOVERNANCE_FILES = new Set([
  "AGENTS.md",
  "DATA_CLASSIFICATION.md",
  "PRIVATE_DATA.md",
  "SOURCE_POLICY.md",
  "DECISION_FRAMEWORK.md",
  "CONVENTIONS.md",
  "REVIEW.md",
  "CHANGELOG.md",
  "README.md",
]);

/** True if the file is a governance/meta doc exempt from the heuristic scanner. */
export function isGovernanceFile(filePath) {
  return GOVERNANCE_FILES.has(path.basename(filePath));
}

/** Luhn checksum — true if the digit string passes (typical of card numbers). */
export function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

// High-confidence Never-store secret signatures.
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const DIGIT_RUN_RE = /\b\d{13,19}\b/g;
// key: value / key = value where value looks like a real secret token.
const SECRET_ASSIGN_RE =
  /\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*["']?([^\s"'`]{8,})["']?/gi;
const PLACEHOLDER_VALUE_RE = /^(<.*>|x{4,}|your[-_].*|example.*|placeholder.*|\*+|\.+)$/i;

/**
 * Scan raw text for secret/PII signatures (classification-independent).
 * @param {string} text
 * @returns {{ blocks: string[], warns: string[] }}
 */
export function scanContent(text) {
  const blocks = [];
  const warns = [];

  if (PRIVATE_KEY_RE.test(text)) blocks.push("private key block detected");
  if (AWS_KEY_RE.test(text)) blocks.push("AWS access key id (AKIA...) detected");

  let m;
  SECRET_ASSIGN_RE.lastIndex = 0;
  while ((m = SECRET_ASSIGN_RE.exec(text)) !== null) {
    const value = m[2];
    if (PLACEHOLDER_VALUE_RE.test(value)) continue; // obvious placeholder, not a real secret
    blocks.push(`possible hardcoded secret in "${m[1]}" assignment`);
  }

  DIGIT_RUN_RE.lastIndex = 0;
  while ((m = DIGIT_RUN_RE.exec(text)) !== null) {
    const run = m[0];
    if (luhn(run)) blocks.push(`card-like number (Luhn-valid, ${run.length} digits) detected`);
    else warns.push(`long digit run (${run.length} digits) — possible account number, prefer private/`);
  }

  if (SSN_RE.test(text)) warns.push("SSN-like pattern — government ID likely belongs in private/");

  return { blocks, warns };
}

/**
 * Heuristic scan for *actual* sensitive personal data that belongs local-only in
 * private/ and must never sit in a tracked file. Deliberately conservative:
 * topic words alone (e.g. "custody", "Chapter 13", "trustee") do NOT fire — the
 * patterns require an accompanying concrete data token (a date next to a birth
 * word, a dollar amount next to pay/bankruptcy words, digits next to "account",
 * an SSN, or explicit custody-order / diagnosis phrasing). This keeps pointers
 * and policy prose clean while catching real leaked values.
 *
 * Known / accepted false-positive controls:
 *   - Governance files (see GOVERNANCE_FILES) are exempt from this scanner.
 *   - Bare "custody" / "Chapter 13 compliance" / "arrears" / "trustee" without a
 *     value are intentionally NOT flagged.
 *   - Bare "diagnosis" / "diagnosed" without a clinical/health cue nearby is
 *     intentionally NOT flagged (ordinary technical usage: "root-cause
 *     diagnosis", "diagnosed the outage").
 *   - Placeholder dates like <YYYY-MM-DD> contain letters and never match.
 *
 * @param {string} text
 * @returns {string[]} block messages
 */
export function scanSensitiveData(text) {
  const blocks = [];

  // A concrete calendar date (ISO, slashed, or "Month DD, YYYY").
  const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})`;
  // A money amount of at least ~four figures ($1,000+ or $1000+).
  const MONEY = String.raw`\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d{4,}(?:\.\d{2})?`;

  // Date of birth: a birth word within ~25 chars of a real date.
  const DOB_RE = new RegExp(
    String.raw`\b(?:born|birth\s?date|date\s+of\s+birth|d\.?o\.?b\.?)\b[^\n]{0,25}(?:${DATE})`,
    "i"
  );
  if (DOB_RE.test(text)) blocks.push("likely date-of-birth (birth word + date) — belongs in private/");

  // SSN in a tracked file (Never-store; also blocked here explicitly).
  if (SSN_RE.test(text)) blocks.push("SSN-like pattern in a tracked file — Never-store / private/ only");

  // Exact salary/pay figure: a pay word within ~30 chars of a money amount.
  const SALARY_RE = new RegExp(
    String.raw`\b(?:salary|gross\s+pay|net\s+pay|take[-\s]?home|annual\s+(?:income|salary)|per\s+paycheck|base\s+pay|wages?)\b[^\n]{0,30}(?:${MONEY})|(?:${MONEY})[^\n]{0,30}\b(?:salary|gross\s+pay|net\s+pay|take[-\s]?home|per\s+paycheck|base\s+pay|annual\s+(?:income|salary))\b`,
    "i"
  );
  if (SALARY_RE.test(text)) blocks.push("likely exact salary/pay figure — belongs in private/");

  // Explicit custody-order language (phrases, not bare "custody").
  const CUSTODY_RE =
    /\b(?:custody\s+order|custody\s+agreement|custody\s+arrangement|parenting\s+plan|parenting\s+time|visitation|sole\s+custody|joint\s+custody|physical\s+custody|legal\s+custody)\b/i;
  if (CUSTODY_RE.test(text)) blocks.push("custody-order language — belongs in private/");

  // Medical diagnosis: a diagnosis word co-occurring with a clinical/health cue
  // within ~40 chars (either order). The bare word alone is intentionally NOT
  // flagged — "root-cause diagnosis", "diagnosed the outage", "the tool
  // diagnoses build failures" are ordinary technical usage. A health cue (a
  // clinical context word or a common condition name) is what marks it as real
  // medical PHI. Because the cue now gates the match, the diagnosis stem is
  // broadened (diagnose/diagnosing included) to raise recall on genuine PHI.
  const HEALTH_CUE = String.raw`doctor|physician|patient|clinic(?:al)?|medical|mental\s+health|psychiatr(?:y|ic|ist)|psycholog(?:ist|ical)|therapist|therapy|prescrib(?:e|ed|ing)|prescription|medication|\bmeds\b|disorder|illness|disease|chronic|depression|anxiety|bipolar|\bADHD\b|\bPTSD\b|\bOCD\b|autis(?:m|tic)|schizophreni\w*|diabet(?:es|ic)|cancer|tumou?r|asthma|epilep(?:sy|tic)|migraine`;
  const DIAGNOSIS_RE = new RegExp(
    String.raw`\bdiagnos(?:is|es|ed|ing|e)\b[^\n]{0,40}(?:${HEALTH_CUE})|(?:${HEALTH_CUE})[^\n]{0,40}\bdiagnos(?:is|es|ed|ing|e)\b`,
    "i"
  );
  if (DIAGNOSIS_RE.test(text)) blocks.push("medical diagnosis language — belongs in private/");

  // Bankruptcy account detail: a bankruptcy word near a real money amount.
  const BK_RE = new RegExp(
    String.raw`\b(?:chapter\s*1?3|chapter\s*7|bankruptcy)\b[^\n]{0,50}(?:${MONEY})|(?:${MONEY})[^\n]{0,50}\b(?:chapter\s*1?3|chapter\s*7|bankruptcy|arrears|trustee|creditor)\b`,
    "i"
  );
  if (BK_RE.test(text)) blocks.push("bankruptcy account detail (case word + amount) — belongs in private/");

  // Account number: an account/routing word next to a run of digits.
  const ACCOUNT_RE = /\b(?:account|acct|routing|iban)\b[^\n]{0,15}(?:no\.?|number|#|:)?\s*\d[\d\s-]{5,}\d/i;
  if (ACCOUNT_RE.test(text)) blocks.push("likely account number (account word + digits) — belongs in private/");

  return blocks;
}

/**
 * Parse .gitignore text and decide whether private/ is excluded from Git.
 * Conservative: true only if a rule explicitly ignores the private directory.
 * @param {string} gitignoreText
 * @returns {boolean}
 */
export function privateExcludedByGitignore(gitignoreText) {
  const lines = gitignoreText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return lines.some((l) => l === "private/" || l === "/private/" || l === "private" || l === "/private");
}

/**
 * When Git is present, list any files tracked under private/. Should always be
 * empty. Returns [] when there is no Git repo (nothing can be tracked yet).
 * @param {string} root
 * @returns {string[]}
 */
export function gitTrackedPrivateFiles(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return [];
  try {
    const out = execFileSync("git", ["ls-files", "private/"], { cwd: root, encoding: "utf8" });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check a single file: content signatures + classification placement.
 * Handles Markdown (.md), claim logs (.jsonl), and YAML (.yaml/.yml). Files
 * under private/ are skipped by the tree collectors, so restricted content there
 * is never treated as a leak.
 * @param {string} filePath absolute or relative path
 * @returns {{ blocks: string[], warns: string[] }}
 */
export function checkFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const { blocks, warns } = scanContent(text);
  const underPrivate = filePath.split(/[\\/]/).includes("private");
  if (underPrivate) return { blocks, warns };

  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".md") {
    const fm = parseFrontMatter(text);
    const cls = fm.data.classification;
    if (cls === "restricted") {
      blocks.push("classification: restricted in a tracked file — must live in private/ (git-excluded)");
    } else if (cls === "sensitive") {
      warns.push("classification: sensitive tracked in Git — requires private-repo + opt-in (DATA_CLASSIFICATION.md)");
    }
    if (!isGovernanceFile(filePath)) {
      for (const b of scanSensitiveData(text)) blocks.push(b);
    }
  } else if (ext === ".jsonl") {
    // A tracked claim declaring itself restricted must live in private/.
    text.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.classification === "restricted") {
          blocks.push(`restricted claim ${obj.id || "(no id)"} in a tracked .jsonl — must live in private/`);
        }
      } catch {
        /* malformed lines are validate-claims' concern, not privacy's */
      }
    });
    for (const b of scanSensitiveData(text)) blocks.push(b);
  } else if (ext === ".yaml" || ext === ".yml") {
    for (const b of scanSensitiveData(text)) blocks.push(b);
  }
  return { blocks, warns };
}

/** Recursively collect Markdown files, skipping IGNORED_DIRS. */
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

/** Recursively collect tracked structured files (.jsonl/.yaml), skipping IGNORED_DIRS. */
export function collectStructured(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.(jsonl|ya?ml)$/i.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Check many files.
 * @param {string[]} files
 * @returns {{ blocks: Array<{file:string,msg:string}>, warns: Array<{file:string,msg:string}> }}
 */
export function checkFiles(files) {
  const blocks = [];
  const warns = [];
  for (const f of files) {
    const r = checkFile(f);
    for (const b of r.blocks) blocks.push({ file: f, msg: b });
    for (const w of r.warns) warns.push({ file: f, msg: w });
  }
  return { blocks, warns };
}

// --- CLI entry point (only when run directly, not when imported) ---
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;

if (isMain) {
  const args = process.argv.slice(2);
  let files;
  if (args.length > 0) {
    files = args.filter((a) => /\.(md|jsonl|ya?ml)$/i.test(a) && fs.existsSync(a));
  } else {
    const root = path.resolve(".");
    files = [...collectMarkdown(root), ...collectStructured(root)];
  }
  const { blocks, warns } = checkFiles(files);
  const rel = (f) => path.relative(path.resolve("."), f) || f;

  // Repo-wide structural guards (only in a full scan, not hook/file mode).
  if (args.length === 0) {
    const root = path.resolve(".");
    const giPath = path.join(root, ".gitignore");
    if (!fs.existsSync(giPath) || !privateExcludedByGitignore(fs.readFileSync(giPath, "utf8"))) {
      blocks.push({ file: ".gitignore", msg: "private/ is not excluded by .gitignore" });
    }
    for (const f of gitTrackedPrivateFiles(root)) {
      blocks.push({ file: f, msg: "file under private/ is tracked by Git — private/ must never be committed" });
    }
  }

  for (const w of warns) console.warn(`WARN  ${rel(w.file)}: ${w.msg}`);
  for (const b of blocks) console.error(`BLOCK ${rel(b.file)}: ${b.msg}`);

  if (blocks.length > 0) {
    console.error(`\nprivacy-check: ${blocks.length} blocking issue(s) across ${files.length} file(s). Commit refused.`);
    process.exit(1);
  }
  console.log(
    `privacy-check: OK — ${files.length} file(s), no Never-store secrets. ${warns.length} warning(s).`
  );
  process.exit(0);
}
