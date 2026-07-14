import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  createRuntimeResult,
  generateExecutionId,
  writeExecutionRecord,
  readExecutionRecord
} from "../plugins/codex/scripts/runtimes/runtime-base.mjs";

function validFields(overrides = {}) {
  return {
    executionId: "exec-abc123-xyz789",
    agentId: "manager-codex",
    role: "manager",
    status: "completed",
    output: "done",
    startedAt: "2026-07-14T00:00:00.000Z",
    endedAt: "2026-07-14T00:00:01.000Z",
    ...overrides
  };
}

test("generateExecutionId: matches the exec-<time>-<6 base36 chars> format", () => {
  const id = generateExecutionId();
  assert.match(id, /^exec-[a-z0-9]+-[a-z0-9]{6}$/);
});

test("generateExecutionId: produces unique ids across calls", () => {
  const ids = new Set(Array.from({ length: 20 }, () => generateExecutionId()));
  assert.equal(ids.size, 20);
});

test("createRuntimeResult: fills defaults for toolCalls, usage, and error", () => {
  const result = createRuntimeResult(validFields());

  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, calls: 0 });
  assert.equal(result.error, null);
  assert.equal(result.executionId, "exec-abc123-xyz789");
  assert.equal(result.agentId, "manager-codex");
  assert.equal(result.role, "manager");
  assert.equal(result.status, "completed");
  assert.equal(result.output, "done");
});

test("createRuntimeResult: returns a frozen object; mutation attempts do not stick", () => {
  const result = createRuntimeResult(validFields());
  assert.equal(Object.isFrozen(result), true);
  try {
    result.status = "failed";
  } catch {
    // strict-mode assignment to a frozen object throws; that's fine too.
  }
  assert.equal(result.status, "completed");
});

test("createRuntimeResult: accepts output as an empty string", () => {
  const result = createRuntimeResult(validFields({ output: "" }));
  assert.equal(result.output, "");
});

test("createRuntimeResult: accepts worker role and every status enum value", () => {
  for (const status of ["completed", "failed", "cancelled", "timeout"]) {
    const result = createRuntimeResult(validFields({ role: "worker", status }));
    assert.equal(result.role, "worker");
    assert.equal(result.status, status);
  }
});

test("createRuntimeResult: throws naming the field for an invalid status", () => {
  assert.throws(() => createRuntimeResult(validFields({ status: "bogus" })), /status/);
});

test("createRuntimeResult: throws naming the field for an invalid role", () => {
  assert.throws(() => createRuntimeResult(validFields({ role: "bogus" })), /role/);
});

test("createRuntimeResult: throws naming the field for a missing executionId", () => {
  const fields = validFields();
  delete fields.executionId;
  assert.throws(() => createRuntimeResult(fields), /executionId/);
});

test("createRuntimeResult: throws naming the field for a missing agentId", () => {
  const fields = validFields();
  delete fields.agentId;
  assert.throws(() => createRuntimeResult(fields), /agentId/);
});

test("createRuntimeResult: throws naming the field for a non-string output", () => {
  assert.throws(() => createRuntimeResult(validFields({ output: 123 })), /output/);
});

test("createRuntimeResult: throws naming the field for a missing startedAt", () => {
  const fields = validFields();
  delete fields.startedAt;
  assert.throws(() => createRuntimeResult(fields), /startedAt/);
});

test("createRuntimeResult: throws naming the field for a missing endedAt", () => {
  const fields = validFields();
  delete fields.endedAt;
  assert.throws(() => createRuntimeResult(fields), /endedAt/);
});

test("writeExecutionRecord + readExecutionRecord: round-trips through a temp dir and merges extra", () => {
  const rootDir = makeTempDir("runtime-base-test-");
  try {
    const result = createRuntimeResult(validFields());
    const filePath = writeExecutionRecord(rootDir, result, { threadId: "t1", turnId: "u1" });

    assert.equal(filePath, path.join(rootDir, ".ai-company", "executions", `${result.executionId}.json`));
    assert.ok(fs.existsSync(filePath));

    const raw = fs.readFileSync(filePath, "utf8");
    assert.ok(raw.endsWith("\n"));

    const read = readExecutionRecord(rootDir, result.executionId);
    assert.equal(read.executionId, result.executionId);
    assert.equal(read.threadId, "t1");
    assert.equal(read.turnId, "u1");
    assert.equal(read.status, "completed");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("writeExecutionRecord: creates the executions directory if missing", () => {
  const rootDir = makeTempDir("runtime-base-test-");
  try {
    const dir = path.join(rootDir, ".ai-company", "executions");
    assert.equal(fs.existsSync(dir), false);
    const result = createRuntimeResult(validFields());
    writeExecutionRecord(rootDir, result);
    assert.equal(fs.existsSync(dir), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readExecutionRecord: returns null for a missing execution id", () => {
  const rootDir = makeTempDir("runtime-base-test-");
  try {
    assert.equal(readExecutionRecord(rootDir, "exec-does-not-exist"), null);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
