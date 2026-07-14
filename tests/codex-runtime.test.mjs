import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { createCodexRuntime } from "../plugins/codex/scripts/runtimes/codex-runtime.mjs";
import { generateExecutionId, readExecutionRecord } from "../plugins/codex/scripts/runtimes/runtime-base.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTempDir(fn) {
  const rootDir = makeTempDir("codex-runtime-test-");
  try {
    await fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// Deterministically predicts the executionId that the *next* generateExecutionId()
// call will produce, by pinning Math.random/Date.now for the duration of the
// caller-supplied synchronous kick-off (execute() calls generateExecutionId()
// synchronously before its first await, so the prediction and the real call see
// the same mocked values).
function withPredictedExecutionId(fn) {
  const originalRandom = Math.random;
  const originalNow = Date.now;
  Math.random = () => 0.123456789;
  Date.now = () => 1_700_000_000_000;
  try {
    const predictedId = generateExecutionId();
    const result = fn();
    return { predictedId, result };
  } finally {
    Math.random = originalRandom;
    Date.now = originalNow;
  }
}

test("execute: success path maps commandExecutions/fileChanges to toolCalls and persists the record", async () => {
  await withTempDir(async (rootDir) => {
    const calls = [];
    const stub = async (cwd, options) => {
      calls.push({ cwd, options });
      return {
        status: 0,
        threadId: "thread-1",
        turnId: "turn-1",
        finalMessage: "All done.",
        reasoningSummary: ["did the thing"],
        stderr: "",
        error: null,
        commandExecutions: [
          { command: "npm test", exitCode: 0 },
          { command: "npm run lint", exitCode: 1 }
        ],
        fileChanges: [{ changes: [{ path: "a.txt" }], status: "completed" }]
      };
    };

    const runtime = createCodexRuntime({ rootDir, runTurn: stub });
    const agent = { id: "manager-codex", runtime: { model: "gpt-5-mini" } };

    const result = await runtime.execute(agent, {}, { prompt: "do the task" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, rootDir);
    assert.equal(calls[0].options.prompt, "do the task");
    assert.equal(calls[0].options.model, "gpt-5-mini");
    assert.equal(calls[0].options.sandbox, "read-only");
    assert.equal(calls[0].options.outputSchema, null);

    assert.equal(result.status, "completed");
    assert.equal(result.role, "manager");
    assert.equal(result.agentId, "manager-codex");
    assert.equal(result.output, "All done.");
    assert.equal(result.error, null);
    assert.equal(result.usage.calls, 1);

    assert.deepEqual(result.toolCalls, [
      { tool: "run_command", args: { command: "npm test" }, result: "0", ok: true },
      { tool: "run_command", args: { command: "npm run lint" }, result: "1", ok: false },
      { tool: "file_change", args: { changes: [{ path: "a.txt" }] }, result: "completed", ok: true }
    ]);

    const recordPath = path.join(rootDir, ".ai-company", "executions", `${result.executionId}.json`);
    assert.ok(fs.existsSync(recordPath));
    const record = readExecutionRecord(rootDir, result.executionId);
    assert.equal(record.threadId, "thread-1");
    assert.equal(record.turnId, "turn-1");
    assert.deepEqual(record.reasoningSummary, ["did the thing"]);
    assert.equal(record.status, "completed");
  });
});

test("execute: manager runs always hardcode sandbox read-only regardless of context", async () => {
  await withTempDir(async (rootDir) => {
    const calls = [];
    const stub = async (cwd, options) => {
      calls.push(options);
      return { status: 0, finalMessage: "ok", commandExecutions: [], fileChanges: [] };
    };
    const runtime = createCodexRuntime({ rootDir, runTurn: stub });

    await runtime.execute({ id: "m1" }, {}, { prompt: "hi", sandbox: "workspace-write" });

    assert.equal(calls[0].sandbox, "read-only");
  });
});

test("execute: failure path sets status failed and error from stderr", async () => {
  await withTempDir(async (rootDir) => {
    const stub = async () => ({
      status: 1,
      finalMessage: "",
      stderr: "codex blew up",
      error: null,
      commandExecutions: [],
      fileChanges: []
    });
    const runtime = createCodexRuntime({ rootDir, runTurn: stub });

    const result = await runtime.execute({ id: "m1" }, {}, { prompt: "hi" });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "codex blew up");
  });
});

test("execute: failure path prefers result.error.message over stderr", async () => {
  await withTempDir(async (rootDir) => {
    const stub = async () => ({
      status: 1,
      finalMessage: "",
      stderr: "raw stderr",
      error: { message: "structured error" },
      commandExecutions: [],
      fileChanges: []
    });
    const runtime = createCodexRuntime({ rootDir, runTurn: stub });

    const result = await runtime.execute({ id: "m1" }, {}, { prompt: "hi" });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "structured error");
  });
});

test("execute: a throwing runTurn returns a persisted failed RuntimeResult instead of rethrowing", async () => {
  await withTempDir(async (rootDir) => {
    const stub = async () => {
      throw new Error("transport exploded");
    };
    const runtime = createCodexRuntime({ rootDir, runTurn: stub });

    const result = await runtime.execute({ id: "m1" }, {}, { prompt: "hi" });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "transport exploded");
    assert.equal(result.output, "");

    const record = readExecutionRecord(rootDir, result.executionId);
    assert.ok(record);
    assert.equal(record.status, "failed");
    assert.equal(record.error, "transport exploded");
  });
});

test("execute: missing prompt throws synchronously as a caller bug, not a transport failure", async () => {
  await withTempDir(async (rootDir) => {
    let called = false;
    const stub = async () => {
      called = true;
      return { status: 0, finalMessage: "", commandExecutions: [], fileChanges: [] };
    };
    const runtime = createCodexRuntime({ rootDir, runTurn: stub });

    await assert.rejects(() => runtime.execute({ id: "m1" }, {}, {}), /prompt/i);
    await assert.rejects(() => runtime.execute({ id: "m1" }, {}, { prompt: "" }), /prompt/i);
    assert.equal(called, false);
  });
});

test("execute: onProgress wrapping tracks threadId/turnId for getStatus and still forwards to the caller", async () => {
  await withTempDir(async (rootDir) => {
    const gate = deferred();
    const seenByCaller = [];
    const stub = async (cwd, options) => {
      options.onProgress({ message: "working", threadId: "t1", turnId: "u1" });
      await gate.promise;
      return { status: 0, finalMessage: "done", commandExecutions: [], fileChanges: [] };
    };
    const runtime = createCodexRuntime({ rootDir, runTurn: stub });

    const { predictedId, result: execPromise } = withPredictedExecutionId(() =>
      runtime.execute({ id: "m1" }, {}, { prompt: "hi", onProgress: (event) => seenByCaller.push(event) })
    );

    // Let the stub's microtasks (including the onProgress call) run before the gate opens.
    await Promise.resolve();
    await Promise.resolve();

    const runningStatus = runtime.getStatus(predictedId);
    assert.equal(runningStatus.state, "running");
    assert.equal(runningStatus.threadId, "t1");
    assert.equal(runningStatus.turnId, "u1");

    assert.deepEqual(seenByCaller, [{ message: "working", threadId: "t1", turnId: "u1" }]);

    gate.resolve();
    const result = await execPromise;

    assert.equal(result.executionId, predictedId);
    const doneStatus = runtime.getStatus(predictedId);
    assert.equal(doneStatus.state, "done");
    assert.equal(doneStatus.threadId, "t1");
    assert.equal(doneStatus.turnId, "u1");
  });
});

test("getStatus: returns null for an unknown execution id", async () => {
  await withTempDir(async (rootDir) => {
    const runtime = createCodexRuntime({ rootDir, runTurn: async () => ({ status: 0, finalMessage: "", commandExecutions: [], fileChanges: [] }) });
    assert.equal(runtime.getStatus("exec-does-not-exist"), null);
  });
});

test("cancel: with tracked threadId/turnId calls interruptTurn and returns attempted true", async () => {
  await withTempDir(async (rootDir) => {
    const gate = deferred();
    const interruptCalls = [];
    const runStub = async (cwd, options) => {
      options.onProgress?.({ message: "working", threadId: "t1", turnId: "u1" });
      await gate.promise;
      return { status: 0, finalMessage: "done", commandExecutions: [], fileChanges: [] };
    };
    const interruptStub = async (cwd, ids) => {
      interruptCalls.push({ cwd, ids });
      return { attempted: true, interrupted: true, transport: "direct", detail: "ok" };
    };
    const runtime = createCodexRuntime({ rootDir, runTurn: runStub, interruptTurn: interruptStub });

    const { predictedId, result: execPromise } = withPredictedExecutionId(() =>
      runtime.execute({ id: "m1" }, {}, { prompt: "hi" })
    );

    await Promise.resolve();
    await Promise.resolve();

    const cancelResult = await runtime.cancel(predictedId);

    assert.equal(cancelResult.attempted, true);
    assert.equal(cancelResult.interrupted, true);
    assert.equal(interruptCalls.length, 1);
    assert.equal(interruptCalls[0].cwd, rootDir);
    assert.deepEqual(interruptCalls[0].ids, { threadId: "t1", turnId: "u1" });

    gate.resolve();
    await execPromise;
  });
});

test("cancel: with an unknown execution id returns attempted false without calling interruptTurn", async () => {
  await withTempDir(async (rootDir) => {
    let interruptCalled = false;
    const runtime = createCodexRuntime({
      rootDir,
      runTurn: async () => ({ status: 0, finalMessage: "", commandExecutions: [], fileChanges: [] }),
      interruptTurn: async () => {
        interruptCalled = true;
        return { attempted: true };
      }
    });

    const cancelResult = await runtime.cancel("exec-unknown-id");

    assert.equal(cancelResult.attempted, false);
    assert.equal(interruptCalled, false);
  });
});
