// Tests for tools/import-chatgpt.mjs — deterministic ChatGPT-export importer.
// Node's built-in runner only. No network, no model, no external deps.
// Run with:  node --test "tools/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  epochToIso,
  slugify,
  messageText,
  linearize,
  toTranscript,
  loadExport,
  importExport,
} from "./import-chatgpt.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axiomce-cgpt-"));
}

// A message node in the OpenAI export shape.
function node(id, parent, children, role, text, extra = {}) {
  return {
    id,
    parent,
    children,
    message:
      role === null
        ? null
        : {
            id: `msg-${id}`,
            author: { role },
            create_time: extra.create_time ?? 1_700_000_000,
            content: extra.content ?? { content_type: "text", parts: [text] },
            metadata: extra.metadata ?? {},
          },
  };
}

// A conversation with an edited-user-message branch: the ACTIVE thread runs
// root -> u1 -> a1(final answer). An abandoned branch a1-old hangs off u1 too.
function sampleConversation() {
  return {
    title: "Migration plan: Hubspot vs Webflow",
    create_time: 1_700_000_000,
    update_time: 1_700_000_500,
    conversation_id: "abc123def456",
    current_node: "a1",
    mapping: {
      root: node("root", null, ["sys"], null, ""),
      sys: node("sys", "root", ["u1"], "system", "You are a helpful assistant.", {
        metadata: { is_visually_hidden_from_conversation: true },
      }),
      u1: node("u1", "sys", ["a1old", "a1"], "user", "We are piloting Webflow at ~60%."),
      a1old: node("a1old", "u1", [], "assistant", "OLD abandoned branch answer."),
      a1: node("a1", "u1", [], "assistant", "Record it as a pilot, not a decision."),
    },
  };
}

test("epochToIso converts unix seconds and tolerates null", () => {
  assert.equal(epochToIso(0), "1970-01-01T00:00:00.000Z");
  assert.equal(epochToIso(null), null);
  assert.equal(epochToIso(undefined), null);
  assert.equal(epochToIso("notanumber"), null);
});

test("slugify is filesystem-safe and bounded", () => {
  assert.equal(slugify("Migration plan: Hubspot vs Webflow"), "migration-plan-hubspot-vs-webflow");
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify(null), "untitled");
  assert.ok(!/[^\w-]/.test(slugify("Wild/Chars? *& stuff!!")));
});

test("messageText handles text parts, code text, and non-string parts", () => {
  assert.equal(messageText({ content: { content_type: "text", parts: ["hello", "world"] } }), "hello\nworld");
  assert.equal(messageText({ content: { content_type: "code", text: "print(1)" } }), "print(1)");
  assert.equal(
    messageText({ content: { content_type: "multimodal_text", parts: ["cap", { asset_pointer: "img" }] } }),
    "cap"
  );
  assert.equal(messageText({ content: { parts: [] } }), "");
  assert.equal(messageText({}), "");
});

test("linearize follows the active thread and drops the abandoned branch", () => {
  const msgs = linearize(sampleConversation());
  // Active thread keeps u1 + a1; drops a1old (other branch), sys (hidden).
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  assert.equal(msgs[1].text, "Record it as a pilot, not a decision.");
  assert.ok(!msgs.some((m) => m.text.includes("OLD abandoned")));
});

test("linearize can include hidden + system roles when asked", () => {
  const msgs = linearize(sampleConversation(), { roles: ["system", "user", "assistant"], includeHidden: true });
  assert.ok(msgs.some((m) => m.role === "system"));
});

test("toTranscript carries provenance and counts", () => {
  const t = toTranscript(sampleConversation());
  assert.equal(t.conversation_id, "abc123def456");
  assert.equal(t.source, "chatgpt:abc123def456");
  assert.equal(t.message_count, 2);
  assert.equal(t.user_message_count, 1);
  assert.equal(t.created, epochToIso(1_700_000_000));
  assert.equal(t.schema, "axiomce.chatgpt-transcript/1");
});

test("loadExport reads an array file and a directory, and rejects a zip", () => {
  const dir = tmpDir();
  const file = path.join(dir, "conversations.json");
  fs.writeFileSync(file, JSON.stringify([sampleConversation()]));
  assert.equal(loadExport(file).length, 1);
  assert.equal(loadExport(dir).length, 1); // finds conversations.json inside
  assert.throws(() => loadExport(path.join(dir, "export.zip")), /not found/);
  fs.writeFileSync(path.join(dir, "export.zip"), "PK");
  assert.throws(() => loadExport(path.join(dir, "export.zip")), /unzip it first/);
});

test("importExport writes transcripts + manifest and defaults under private/", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify([sampleConversation()]));
  const out = path.join(dir, "private", "inbox", "chatgpt");
  const res = importExport(path.join(dir, "conversations.json"), { outDir: out });

  assert.equal(res.written, 1);
  assert.ok(fs.existsSync(res.manifestPath));
  const manifest = JSON.parse(fs.readFileSync(res.manifestPath, "utf8"));
  assert.equal(manifest.schema, "axiomce.chatgpt-manifest/1");
  assert.equal(manifest.conversations.length, 1);
  assert.equal(manifest.conversations[0].source, "chatgpt:abc123def456");

  const tfile = path.join(out, manifest.conversations[0].file);
  assert.ok(fs.existsSync(tfile));
  const transcript = JSON.parse(fs.readFileSync(tfile, "utf8"));
  assert.equal(transcript.messages.length, 2);
  // The abandoned branch must never reach a transcript.
  assert.ok(!fs.readFileSync(tfile, "utf8").includes("OLD abandoned"));
});

test("importExport applies --since, --limit, and --min-messages filters", () => {
  const dir = tmpDir();
  const older = { ...sampleConversation(), conversation_id: "old1", update_time: 1_600_000_000 };
  const empty = {
    title: "empty",
    conversation_id: "empty1",
    update_time: 1_700_000_600,
    current_node: "u",
    mapping: { u: node("u", null, [], "user", "") }, // empty text -> 0 kept msgs
  };
  fs.writeFileSync(
    path.join(dir, "conversations.json"),
    JSON.stringify([sampleConversation(), older, empty])
  );
  const out = path.join(dir, "out");

  // since filter drops the 2016 conversation
  const r1 = importExport(path.join(dir, "conversations.json"), { outDir: out, since: "2023-01-01" });
  const m1 = JSON.parse(fs.readFileSync(r1.manifestPath, "utf8"));
  assert.ok(!m1.conversations.some((c) => c.conversation_id === "old1"));
  // empty conversation dropped by min-messages default (>=1)
  assert.ok(!m1.conversations.some((c) => c.conversation_id === "empty1"));

  // limit caps the count
  const r2 = importExport(path.join(dir, "conversations.json"), { outDir: path.join(dir, "out2"), limit: 1 });
  assert.equal(r2.written, 1);
});
