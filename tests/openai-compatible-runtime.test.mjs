import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { createOpenAICompatibleRuntime } from "../plugins/codex/scripts/runtimes/openai-compatible-runtime.mjs";
import { readExecutionRecord } from "../plugins/codex/scripts/runtimes/runtime-base.mjs";
import { resolveProvider, BUILTIN_PROVIDERS } from "../plugins/codex/scripts/runtimes/provider-presets.mjs";
import { createFakeOpenAIServer, toolCall, toolCallResponse, contentResponse } from "./fake-openai-fixture.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir(fn) {
  const rootDir = makeTempDir("openai-runtime-test-");
  try {
    await fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function withServer(responses, fn) {
  const server = await createFakeOpenAIServer({ responses });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

function makeAgent(overrides = {}) {
  return {
    id: "worker-1",
    runtime: { provider: "openai-compatible", model: "test-model" },
    permissions: { read: ["**"], write: ["tests/**", "src/**"] },
    limits: {},
    ...overrides
  };
}

function makeEnv(server, overrides = {}) {
  return {
    OPENAI_COMPAT_BASE_URL: server.url,
    OPENAI_COMPAT_API_KEY: "test-key",
    ...overrides
  };
}

function validTaskResult(overrides = {}) {
  return {
    taskId: "task-1",
    agentId: "worker-1",
    summary: "did the thing",
    status: "completed",
    changedFiles: [],
    commandsExecuted: [],
    verification: { passed: true, details: "ok" },
    risks: [],
    memoryProposals: [],
    skillProposals: [],
    ...overrides
  };
}

const BASE_CONTEXT = { systemPrompt: "You are a worker.", userPrompt: "Do the task." };

// --- Input Validation: agent validation before any state mutation -----------

test("execute: null agent rejects before creating an execution entry", async () => {
  await withTempDir(async (rootDir) => {
    const runtime = createOpenAICompatibleRuntime({ rootDir });
    const task = { taskId: "task-1", verificationCommands: [] };

    await assert.rejects(
      async () => runtime.execute(null, task, BASE_CONTEXT),
      /agent is required and must be an object/
    );

    // Verify no execution entry was created
    assert.equal(runtime.getStatus("any-id"), null);

    // Verify no execution record was written
    const executionsDir = path.join(rootDir, ".ai-company", "executions");
    const dirExists = fs.existsSync(executionsDir);
    if (dirExists) {
      const files = fs.readdirSync(executionsDir);
      assert.equal(files.length, 0, "executions directory should be empty");
    }
  });
});

test("execute: agent without an id rejects before creating an execution entry", async () => {
  await withTempDir(async (rootDir) => {
    const runtime = createOpenAICompatibleRuntime({ rootDir });
    const task = { taskId: "task-1", verificationCommands: [] };

    await assert.rejects(
      async () => runtime.execute({}, task, BASE_CONTEXT),
      /agent.id is required and must be a non-empty string/
    );

    // Verify no execution entry was created
    assert.equal(runtime.getStatus("any-id"), null);

    // Verify no execution record was written
    const executionsDir = path.join(rootDir, ".ai-company", "executions");
    const dirExists = fs.existsSync(executionsDir);
    if (dirExists) {
      const files = fs.readdirSync(executionsDir);
      assert.equal(files.length, 0, "executions directory should be empty");
    }
  });
});

test("execute: agent with empty string id rejects before creating an execution entry", async () => {
  await withTempDir(async (rootDir) => {
    const runtime = createOpenAICompatibleRuntime({ rootDir });
    const task = { taskId: "task-1", verificationCommands: [] };

    await assert.rejects(
      async () => runtime.execute({ id: "" }, task, BASE_CONTEXT),
      /agent.id is required and must be a non-empty string/
    );

    // Verify no execution entry was created
    assert.equal(runtime.getStatus("any-id"), null);

    // Verify no execution record was written
    const executionsDir = path.join(rootDir, ".ai-company", "executions");
    const dirExists = fs.existsSync(executionsDir);
    if (dirExists) {
      const files = fs.readdirSync(executionsDir);
      assert.equal(files.length, 0, "executions directory should be empty");
    }
  });
});

// --- Scenario 1: happy path -------------------------------------------------

test("execute: happy path (read -> write -> run_command -> submit_result) completes and never leaks the api key", async () => {
  await withTempDir(async (rootDir) => {
    fs.writeFileSync(path.join(rootDir, "a.txt"), "hello world", "utf8");

    await withServer(
      [
        toolCallResponse([toolCall("read_file", { path: "a.txt" })], { usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        toolCallResponse([toolCall("write_file", { path: "src/out.txt", content: "written" })]),
        toolCallResponse([toolCall("run_command", { command: "npm test" })], { usage: { prompt_tokens: 7, completion_tokens: 3 } }),
        toolCallResponse([toolCall("submit_result", { result: validTaskResult() })])
      ],
      async (server) => {
        const runCommandCalls = [];
        const runtime = createOpenAICompatibleRuntime({
          rootDir,
          env: makeEnv(server),
          runCommand: async (command, options) => {
            runCommandCalls.push({ command, options });
            return { code: 0, output: "ok" };
          }
        });

        const task = { taskId: "task-1", verificationCommands: ["npm test"] };
        const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

        assert.equal(result.status, "completed");
        assert.equal(result.error, null);
        assert.equal(result.output, JSON.stringify(validTaskResult()));

        assert.equal(fs.readFileSync(path.join(rootDir, "src", "out.txt"), "utf8"), "written");

        assert.equal(result.toolCalls.length, 4);
        assert.deepEqual(
          result.toolCalls.map((c) => c.tool),
          ["read_file", "write_file", "run_command", "submit_result"]
        );
        assert.ok(result.toolCalls.every((c) => c.ok === true));

        assert.equal(runCommandCalls.length, 1);
        assert.equal(runCommandCalls[0].command, "npm test");
        assert.equal(runCommandCalls[0].options.cwd, rootDir);

        assert.equal(result.usage.calls, 4);
        assert.equal(result.usage.inputTokens, 17);
        assert.equal(result.usage.outputTokens, 8);

        const recordPath = path.join(rootDir, ".ai-company", "executions", `${result.executionId}.json`);
        assert.ok(fs.existsSync(recordPath));
        const rawRecord = fs.readFileSync(recordPath, "utf8");
        assert.ok(!rawRecord.includes("test-key"));

        const record = readExecutionRecord(rootDir, result.executionId);
        assert.ok(Array.isArray(record.transcript));
        assert.equal(record.provider, "openai-compatible");
        assert.equal(record.model, "test-model");
      }
    );
  });
});

// --- Scenario 2: permission denial does not kill the loop -------------------

test("execute: a permission-denied write_file surfaces ERROR: to the model and does not abort the run", async () => {
  await withTempDir(async (rootDir) => {
    await withServer(
      [
        toolCallResponse([toolCall("write_file", { path: "docs/x.md", content: "nope" })]),
        toolCallResponse([toolCall("submit_result", { result: validTaskResult() })])
      ],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const task = { taskId: "task-1", verificationCommands: [] };
        const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

        assert.equal(result.status, "completed");
        assert.equal(result.toolCalls[0].ok, false);
        assert.match(result.toolCalls[0].result, /^ERROR:/);
        assert.equal(fs.existsSync(path.join(rootDir, "docs", "x.md")), false);
      }
    );
  });
});

// --- Scenario 3: run_command allowlist exact match --------------------------

test("execute: run_command rejects non-allowlisted commands and allows an exact allowlist match", async () => {
  await withTempDir(async (rootDir) => {
    await withServer(
      [
        toolCallResponse([toolCall("run_command", { command: "rm -rf /" })]),
        toolCallResponse([toolCall("run_command", { command: "npm test" })]),
        toolCallResponse([toolCall("submit_result", { result: validTaskResult() })])
      ],
      async (server) => {
        const runCommandCalls = [];
        const runtime = createOpenAICompatibleRuntime({
          rootDir,
          env: makeEnv(server),
          runCommand: async (command) => {
            runCommandCalls.push(command);
            return { code: 0, output: "" };
          }
        });
        const task = { taskId: "task-1", verificationCommands: ["npm test"] };
        const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

        assert.equal(result.status, "completed");
        assert.equal(result.toolCalls[0].ok, false);
        assert.match(result.toolCalls[0].result, /^ERROR: command not allowed: rm -rf \/$/);
        assert.equal(result.toolCalls[1].ok, true);

        assert.deepEqual(runCommandCalls, ["npm test"]);
      }
    );
  });
});

// --- Scenario 4: submit_result schema validation ----------------------------

test("execute: an invalid submit_result gets one retry chance then succeeds", async () => {
  await withTempDir(async (rootDir) => {
    await withServer(
      [
        toolCallResponse([toolCall("submit_result", { result: {} })]),
        toolCallResponse([toolCall("submit_result", { result: validTaskResult() })])
      ],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const task = { taskId: "task-1", verificationCommands: [] };
        const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

        assert.equal(result.status, "completed");
        assert.equal(result.toolCalls.length, 2);
        assert.equal(result.toolCalls[0].ok, false);
        assert.match(result.toolCalls[0].result, /^ERROR:/);
        assert.equal(result.toolCalls[1].ok, true);

        // The audit-trail toolCalls[].result is capped at 400 chars (per spec), which can
        // truncate a long schema-error listing before the "fix and resubmit" suffix. The
        // uncapped tool message actually sent back to the model still carries it in full.
        const record = readExecutionRecord(rootDir, result.executionId);
        const firstToolMessage = record.transcript.find((m) => m.role === "tool" && m.content?.startsWith("ERROR:"));
        assert.ok(firstToolMessage, "expected an ERROR tool message in the transcript");
        assert.match(firstToolMessage.content, /fix and resubmit/);
      }
    );
  });
});

test("execute: a submit_result invalid twice in a row fails the run", async () => {
  await withTempDir(async (rootDir) => {
    await withServer(
      [
        toolCallResponse([toolCall("submit_result", { result: {} })]),
        toolCallResponse([toolCall("submit_result", { result: { foo: 1 } })])
      ],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const task = { taskId: "task-1", verificationCommands: [] };
        const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

        assert.equal(result.status, "failed");
        assert.equal(result.error, "submit_result failed schema validation twice");
      }
    );
  });
});

// --- Scenario 5: maxToolCalls bound ------------------------------------------

test("execute: exceeding maxToolCalls fails the run and dispatches no more than the limit", async () => {
  await withTempDir(async (rootDir) => {
    fs.writeFileSync(path.join(rootDir, "a.txt"), "hello", "utf8");

    await withServer(
      [
        toolCallResponse([
          toolCall("read_file", { path: "a.txt" }),
          toolCall("read_file", { path: "a.txt" }),
          toolCall("read_file", { path: "a.txt" })
        ])
      ],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const agent = makeAgent({ limits: { maxToolCalls: 2 } });
        const task = { taskId: "task-1", verificationCommands: [] };
        const result = await runtime.execute(agent, task, BASE_CONTEXT);

        assert.equal(result.status, "failed");
        assert.equal(result.error, "tool call limit exceeded");
        assert.ok(result.toolCalls.length <= 2);
      }
    );
  });
});

// --- Scenario 6: wall-clock timeout ------------------------------------------

test("execute: a wall-clock deadline in the past produces a timeout status", async () => {
  await withTempDir(async (rootDir) => {
    await withServer(
      [
        async () => {
          await sleep(20);
          return contentResponse("still thinking");
        }
      ],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const agent = makeAgent({ limits: { maxExecutionMinutes: 0.0001 } });
        const task = { taskId: "task-1", verificationCommands: [] };
        const result = await runtime.execute(agent, task, BASE_CONTEXT);

        assert.equal(result.status, "timeout");
      }
    );
  });
});

// --- Scenario 7: content-only nudge then failure ----------------------------

test("execute: a content-only response is nudged once, then fails if it happens again", async () => {
  await withTempDir(async (rootDir) => {
    await withServer(
      [contentResponse("just thinking"), contentResponse("still thinking")],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const task = { taskId: "task-1", verificationCommands: [] };
        const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

        assert.equal(result.status, "failed");
        assert.equal(result.error, "model finished without submit_result");

        const record = readExecutionRecord(rootDir, result.executionId);
        const nudgeMessage = record.transcript.find(
          (m) => m.role === "user" && m.content === "You must call submit_result with a task-result document to finish."
        );
        assert.ok(nudgeMessage, "expected the nudge message to be present in the transcript");
      }
    );
  });
});

// --- Scenario 8: 429 retry --------------------------------------------------

test("execute: a 429 response is retried once and succeeds, counting both HTTP attempts", async () => {
  await withTempDir(async (rootDir) => {
    await withServer(
      [
        { status: 429, body: { error: "rate limited" } },
        toolCallResponse([toolCall("submit_result", { result: validTaskResult() })])
      ],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const task = { taskId: "task-1", verificationCommands: [] };
        const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

        assert.equal(result.status, "completed");
        assert.equal(result.usage.calls, 2);
        assert.equal(server.requests.length, 2);
      }
    );
  });
});

// --- Scenario 9: missing API key ---------------------------------------------

test("execute: a missing API key fails without making any HTTP request", async () => {
  await withTempDir(async (rootDir) => {
    await withServer([], async (server) => {
      const runtime = createOpenAICompatibleRuntime({
        rootDir,
        env: { OPENAI_COMPAT_BASE_URL: server.url }
      });
      const task = { taskId: "task-1", verificationCommands: [] };
      const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

      assert.equal(result.status, "failed");
      assert.match(result.error, /OPENAI_COMPAT_API_KEY/);
      assert.equal(server.requests.length, 0);

      const record = readExecutionRecord(rootDir, result.executionId);
      assert.ok(record);
    });
  });
});

// --- Scenario 10: cancel mid-request -----------------------------------------

test("cancel: aborting a delayed in-flight request finalizes the run as cancelled", async () => {
  await withTempDir(async (rootDir) => {
    // The fixture holds the HTTP response open for 1000ms. cancelRequested alone
    // cannot resolve the run until the *next* loop iteration reaches its check --
    // the only way execute() can resolve to "cancelled" well before the fixture's
    // delay elapses is if cancel() actually aborts the in-flight fetch. This proves
    // real interruption rather than a cancelRequested flag that happens to be
    // observed on a later loop pass.
    const FIXTURE_DELAY_MS = 1000;
    const MAX_ACCEPTABLE_RESOLUTION_MS = 400;

    await withServer(
      [
        async () => {
          await sleep(FIXTURE_DELAY_MS);
          return contentResponse("too late");
        }
      ],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const task = { taskId: "task-1", verificationCommands: [] };

        let capturedExecutionId = null;
        const onProgress = (event) => {
          if (!capturedExecutionId && event?.executionId) {
            capturedExecutionId = event.executionId;
          }
        };

        const executePromise = runtime.execute(makeAgent(), task, { ...BASE_CONTEXT, onProgress });

        assert.ok(capturedExecutionId, "expected onProgress to report an executionId synchronously");
        assert.deepEqual(runtime.getStatus(capturedExecutionId), { executionId: capturedExecutionId, state: "running" });

        const cancelResult = await runtime.cancel(capturedExecutionId);
        assert.equal(cancelResult.attempted, true);

        const beforeResolveMs = Date.now();
        const result = await executePromise;
        const resolutionMs = Date.now() - beforeResolveMs;

        assert.equal(result.status, "cancelled");
        assert.equal(result.executionId, capturedExecutionId);
        assert.deepEqual(runtime.getStatus(capturedExecutionId), { executionId: capturedExecutionId, state: "done" });
        assert.ok(
          resolutionMs < MAX_ACCEPTABLE_RESOLUTION_MS,
          `expected cancel to abort the in-flight fetch and resolve in well under the ` +
            `${FIXTURE_DELAY_MS}ms fixture delay (took ${resolutionMs}ms) -- a no-op abort() ` +
            `would only resolve once the fixture's response arrives`
        );
      }
    );
  });
});

test("cancel: an unknown execution id returns attempted false", async () => {
  await withTempDir(async (rootDir) => {
    const runtime = createOpenAICompatibleRuntime({ rootDir });
    const cancelResult = await runtime.cancel("exec-unknown-id");
    assert.equal(cancelResult.attempted, false);
    assert.equal(runtime.getStatus("exec-unknown-id"), null);
  });
});

// --- Scenario 11: resolveProvider --------------------------------------------

test("resolveProvider: deepseek builtin defaults when no env override is set", () => {
  const provider = resolveProvider("deepseek", { env: {} });
  assert.deepEqual(provider, {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: null,
    model: "deepseek-chat",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY"
  });
});

test("resolveProvider: env vars override the base URL and supply the api key", () => {
  const provider = resolveProvider("deepseek", {
    env: { DEEPSEEK_BASE_URL: "https://deepseek.example.internal", DEEPSEEK_API_KEY: "sk-abc" }
  });
  assert.equal(provider.baseUrl, "https://deepseek.example.internal");
  assert.equal(provider.apiKey, "sk-abc");
});

test("resolveProvider: a rootDir runtimes.json override merges over the builtin", async () => {
  await withTempDir(async (rootDir) => {
    const aiCompanyDir = path.join(rootDir, ".ai-company");
    fs.mkdirSync(aiCompanyDir, { recursive: true });
    fs.writeFileSync(
      path.join(aiCompanyDir, "runtimes.json"),
      JSON.stringify({
        deepseek: { defaultModel: "deepseek-reasoner" },
        "custom-provider": {
          baseUrlEnv: "CUSTOM_BASE_URL",
          defaultBaseUrl: "https://custom.example.com",
          apiKeyEnv: "CUSTOM_API_KEY",
          defaultModel: "custom-model"
        }
      })
    );

    const deepseek = resolveProvider("deepseek", { env: {}, rootDir });
    assert.equal(deepseek.model, "deepseek-reasoner");
    assert.equal(deepseek.baseUrl, "https://api.deepseek.com");

    const custom = resolveProvider("custom-provider", { env: { CUSTOM_API_KEY: "sk-custom" }, rootDir });
    assert.equal(custom.baseUrl, "https://custom.example.com");
    assert.equal(custom.apiKey, "sk-custom");
    assert.equal(custom.model, "custom-model");
  });
});

test("resolveProvider: an unknown provider id with no override throws", () => {
  assert.throws(() => resolveProvider("does-not-exist", { env: {} }), /Unknown runtime provider: does-not-exist/);
});

test("resolveProvider: a malformed runtimes.json is ignored, falling back to builtins", async () => {
  await withTempDir(async (rootDir) => {
    const aiCompanyDir = path.join(rootDir, ".ai-company");
    fs.mkdirSync(aiCompanyDir, { recursive: true });
    fs.writeFileSync(path.join(aiCompanyDir, "runtimes.json"), "{ not valid json");

    const provider = resolveProvider("deepseek", { env: {}, rootDir });
    assert.equal(provider.model, "deepseek-chat");
    assert.equal(provider.baseUrl, "https://api.deepseek.com");
  });
});

test("BUILTIN_PROVIDERS: exposes the deepseek and openai-compatible presets", () => {
  assert.deepEqual(Object.keys(BUILTIN_PROVIDERS).sort(), ["deepseek", "openai-compatible"]);
});

// --- Bonus: default runCommand sanity check (not one of the 11 scenarios) ---

test("execute: the default runCommand implementation actually runs the allowlisted command", async () => {
  await withTempDir(async (rootDir) => {
    const command = process.platform === "win32" ? "node -e \"process.exit(0)\"" : "node -e 'process.exit(0)'";
    await withServer(
      [
        toolCallResponse([toolCall("run_command", { command })]),
        toolCallResponse([toolCall("submit_result", { result: validTaskResult() })])
      ],
      async (server) => {
        const runtime = createOpenAICompatibleRuntime({ rootDir, env: makeEnv(server) });
        const task = { taskId: "task-1", verificationCommands: [command] };
        const result = await runtime.execute(makeAgent(), task, BASE_CONTEXT);

        assert.equal(result.status, "completed");
        assert.equal(result.toolCalls[0].ok, true);
        assert.match(result.toolCalls[0].result, /^exit 0/);
      }
    );
  });
});
