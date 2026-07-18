import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  interpolateTemplate,
  loadPromptTemplate,
} from "../plugins/codex/scripts/lib/prompts.mjs";

// ---------------------------------------------------------------------------
// interpolateTemplate – single token
// ---------------------------------------------------------------------------

test("interpolateTemplate: single {{TOKEN}} substitution", () => {
  const result = interpolateTemplate("Hello {{NAME}}!", { NAME: "World" });
  assert.equal(result, "Hello World!");
});

// ---------------------------------------------------------------------------
// interpolateTemplate – multiple tokens
// ---------------------------------------------------------------------------

test("interpolateTemplate: multiple different tokens in one template", () => {
  const result = interpolateTemplate("{{GREETING}}, {{NAME}}!", {
    GREETING: "Hi",
    NAME: "Alice",
  });
  assert.equal(result, "Hi, Alice!");
});

// ---------------------------------------------------------------------------
// interpolateTemplate – repeated token
// ---------------------------------------------------------------------------

test("interpolateTemplate: same token repeated", () => {
  const result = interpolateTemplate("{{X}} + {{X}} = {{Y}}", {
    X: "1",
    Y: "2",
  });
  assert.equal(result, "1 + 1 = 2");
});

// ---------------------------------------------------------------------------
// interpolateTemplate – unknown token replaced with empty string
// ---------------------------------------------------------------------------

test("interpolateTemplate: unknown token replaced with empty string", () => {
  const result = interpolateTemplate("Hello {{NAME}}!", {});
  assert.equal(result, "Hello !");
});

// ---------------------------------------------------------------------------
// interpolateTemplate – no tokens
// ---------------------------------------------------------------------------

test("interpolateTemplate: template with no tokens returned unchanged", () => {
  const result = interpolateTemplate("Hello World!", { NAME: "foo" });
  assert.equal(result, "Hello World!");
});

// ---------------------------------------------------------------------------
// interpolateTemplate – non-uppercase keys left literal
// ---------------------------------------------------------------------------

test("interpolateTemplate: non-uppercase keys left literal ({{lower}})", () => {
  const result = interpolateTemplate("Hello {{lower}}!", { lower: "world" });
  assert.equal(result, "Hello {{lower}}!");
});

test("interpolateTemplate: non-uppercase keys left literal ({{Mixed1}})", () => {
  const result = interpolateTemplate("Hello {{Mixed1}}!", { Mixed1: "world" });
  assert.equal(result, "Hello {{Mixed1}}!");
});

// ---------------------------------------------------------------------------
// loadPromptTemplate
// ---------------------------------------------------------------------------

test("loadPromptTemplate: reads prompts/<name>.md from rootDir", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-test-"));
  try {
    const promptsDir = path.join(tmpDir, "prompts");
    fs.mkdirSync(promptsDir);
    const expectedContent = "# Hello World\n\nThis is a test prompt.";
    fs.writeFileSync(path.join(promptsDir, "greeting.md"), expectedContent, "utf8");

    const result = loadPromptTemplate(tmpDir, "greeting");
    assert.equal(result, expectedContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
