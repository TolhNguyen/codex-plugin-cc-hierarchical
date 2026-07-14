/**
 * OpenAI-compatible chat-completions worker runtime. This is the engine of
 * the worker tier: it drives a bounded tool-calling loop against any
 * chat/completions endpoint (DeepSeek, a self-hosted OpenAI-compatible
 * gateway, ...) and exposes exactly five guarded tools to the model:
 * `read_file`, `list_dir`, `write_file`, `run_command`, `submit_result`.
 *
 * Security posture (do not weaken without re-reading docs/TARGET_ARCHITECTURE.md §4):
 *  - The API key is read from `env` at call time, held in a local variable,
 *    and never written to any file, execution record, tool message, error
 *    message, or log line. Only the `Authorization` header of the outbound
 *    HTTP request ever carries it.
 *  - Every `read_file`/`list_dir` call goes through `guard.assertRead`, every
 *    `write_file` through `guard.assertWrite`. Nothing bypasses the guard.
 *  - `run_command` only ever runs a command that is an exact string match
 *    against `task.verificationCommands`.
 *  - The loop is bounded by both `limits.maxToolCalls` and a wall-clock
 *    deadline derived from `limits.maxExecutionMinutes`; every dispatch and
 *    every HTTP round re-checks both before proceeding.
 *  - `execute()` never throws once inputs are validated: every code path
 *    ends in a persisted RuntimeResult (completed/failed/cancelled/timeout).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createRuntimeResult, generateExecutionId, writeExecutionRecord } from "./runtime-base.mjs";
import { createPermissionGuard } from "../agents/permission-guard.mjs";
import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { resolveProvider } from "./provider-presets.mjs";

const DEFAULT_MAX_TOOL_CALLS = 40;
const DEFAULT_MAX_EXECUTION_MINUTES = 20;
const MAX_FILE_READ_BYTES = 64 * 1024;
const MAX_DIR_ENTRIES = 200;
const MAX_TOOL_CALL_RESULT_CHARS = 400;
const MAX_HTTP_ERROR_BODY_CHARS = 1024;
const MAX_COMMAND_OUTPUT_CHARS = 10 * 1024;
const RETRY_DELAY_MS = 250;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const NUDGE_MESSAGE = "You must call submit_result with a task-result document to finish.";

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace (capped at 64KB).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path." } },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries in a workspace directory (max 200 entries; directories suffixed with '/').",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative directory path." } },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 text file inside the workspace, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "File content to write." }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run one of the task's pre-approved verification commands (exact string match only).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Must exactly match one of task.verificationCommands." }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "submit_result",
      description: "Submit the final task-result document and end the run.",
      parameters: {
        type: "object",
        properties: { result: { type: "object", description: "A task-result document." } },
        required: ["result"],
        additionalProperties: false
      }
    }
  }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capString(value, max) {
  if (typeof value !== "string") {
    return value;
  }
  return value.length > max ? value.slice(0, max) : value;
}

function trimTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function defaultRunCommand(command, { cwd, timeoutMs }) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    windowsHide: true,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });

  const code = result.status !== null && result.status !== undefined ? result.status : result.signal ? 1 : 0;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { code, output };
}

function parseToolArguments(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, args: parsed };
    }
    return { ok: false, args: {} };
  } catch {
    return { ok: false, args: {} };
  }
}

/**
 * @param {{
 *   rootDir: string,
 *   fetchImpl?: typeof fetch,
 *   env?: object,
 *   runCommand?: (command: string, options: { cwd: string, timeoutMs: number }) => Promise<{ code: number, output: string }> | { code: number, output: string },
 *   now?: () => string
 * }} [options]
 */
export function createOpenAICompatibleRuntime({
  rootDir,
  fetchImpl = fetch,
  env = process.env,
  runCommand = defaultRunCommand,
  now = () => new Date().toISOString()
} = {}) {
  /** @type {Map<string, { state: "running" | "done", cancelRequested: boolean, controller: AbortController | null }>} */
  const executions = new Map();

  async function execute(agent, task, context = {}) {
    const { systemPrompt, userPrompt, onProgress } = context;
    if (typeof systemPrompt !== "string" || systemPrompt.length === 0) {
      throw new Error("context.systemPrompt is required and must be a non-empty string.");
    }
    if (typeof userPrompt !== "string" || userPrompt.length === 0) {
      throw new Error("context.userPrompt is required and must be a non-empty string.");
    }
    if (!agent || typeof agent !== "object") {
      throw new Error("agent is required and must be an object.");
    }
    if (typeof agent.id !== "string" || agent.id.length === 0) {
      throw new Error("agent.id is required and must be a non-empty string.");
    }

    const executionId = generateExecutionId();
    const startedAt = now();
    const startedAtMs = Date.now();
    const entry = { state: "running", cancelRequested: false, controller: null };
    executions.set(executionId, entry);

    const agentId = agent.id;
    const requestedProviderId = agent?.runtime?.provider ?? null;
    const maxToolCalls = agent?.limits?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const maxExecutionMinutes = agent?.limits?.maxExecutionMinutes ?? DEFAULT_MAX_EXECUTION_MINUTES;
    const deadlineMs = startedAtMs + maxExecutionMinutes * 60 * 1000;
    const verificationCommands = Array.isArray(task?.verificationCommands) ? task.verificationCommands : [];

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ];
    const toolCalls = [];
    let usageCalls = 0;
    let usageInputTokens = null;
    let usageOutputTokens = null;
    let anyUsageSeen = false;
    let nudged = false;
    let invalidSubmitCount = 0;
    let resolvedModel = null;

    function usageSummary() {
      return {
        inputTokens: anyUsageSeen ? usageInputTokens : null,
        outputTokens: anyUsageSeen ? usageOutputTokens : null,
        calls: usageCalls
      };
    }

    function finish(status, output, error, extra = {}) {
      entry.state = "done";
      const endedAt = now();
      const result = createRuntimeResult({
        executionId,
        agentId,
        role: "worker",
        status,
        output,
        toolCalls,
        usage: usageSummary(),
        startedAt,
        endedAt,
        error
      });
      writeExecutionRecord(rootDir, result, {
        transcript: messages,
        taskId: task?.taskId ?? null,
        provider: requestedProviderId,
        model: resolvedModel,
        ...extra
      });
      onProgress?.({ message: `execution ${status}`, phase: "completion", executionId });
      return result;
    }

    let provider;
    try {
      provider = resolveProvider(requestedProviderId, { env, rootDir });
      resolvedModel = agent?.runtime?.model ?? provider.model ?? null;
      if (!resolvedModel) {
        throw new Error(`Missing model: set agent.runtime.model or a default model for provider ${provider.id}`);
      }
    } catch (error) {
      return finish("failed", "", error.message);
    }

    if (!provider.apiKey) {
      return finish("failed", "", `Missing API key: set ${provider.apiKeyEnv}`);
    }
    if (!provider.baseUrl) {
      return finish("failed", "", `Missing base URL: set ${provider.baseUrlEnv}`);
    }

    const guard = createPermissionGuard(rootDir, agent?.permissions);
    const endpoint = `${trimTrailingSlash(provider.baseUrl)}/chat/completions`;
    const model = resolvedModel;

    async function sendChatRequest() {
      const controller = new AbortController();
      entry.controller = controller;
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey}`
          },
          body: JSON.stringify({ model, messages, tools: TOOL_DEFS, tool_choice: "auto", temperature: 0 }),
          signal: controller.signal
        });
        usageCalls += 1;
        return { response, networkError: null };
      } catch (networkError) {
        usageCalls += 1;
        return { response: null, networkError };
      } finally {
        if (entry.controller === controller) {
          entry.controller = null;
        }
      }
    }

    function isRetryableStatus(status) {
      return status === 429 || status >= 500;
    }

    async function requestRound() {
      let attempt = await sendChatRequest();
      if (attempt.networkError) {
        return attempt;
      }
      if (!attempt.response.ok && isRetryableStatus(attempt.response.status)) {
        await sleep(RETRY_DELAY_MS);
        attempt = await sendChatRequest();
      }
      return attempt;
    }

    async function readCappedErrorBody(response) {
      try {
        const text = await response.text();
        return capString(text, MAX_HTTP_ERROR_BODY_CHARS);
      } catch {
        return "";
      }
    }

    async function dispatchTool(name, args) {
      try {
        switch (name) {
          case "read_file": {
            const resolved = guard.assertRead(args.path);
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
              return { ok: false, content: "ERROR: not found" };
            }
            if (fs.statSync(resolved).size > MAX_FILE_READ_BYTES) {
              return { ok: false, content: "ERROR: file too large" };
            }
            return { ok: true, content: fs.readFileSync(resolved, "utf8") };
          }

          case "list_dir": {
            const resolved = guard.assertRead(args.path);
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
              return { ok: false, content: "ERROR: not found" };
            }
            const dirents = fs.readdirSync(resolved, { withFileTypes: true });
            const names = dirents.slice(0, MAX_DIR_ENTRIES).map((d) => `${d.name}${d.isDirectory() ? "/" : ""}`);
            return { ok: true, content: names.join("\n") };
          }

          case "write_file": {
            const resolved = guard.assertWrite(args.path);
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, typeof args.content === "string" ? args.content : "", "utf8");
            return { ok: true, content: "ok" };
          }

          case "run_command": {
            if (!verificationCommands.includes(args.command)) {
              return { ok: false, content: `ERROR: command not allowed: ${args.command}` };
            }
            const commandResult = await runCommand(args.command, { cwd: rootDir, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
            const output = capString(commandResult.output ?? "", MAX_COMMAND_OUTPUT_CHARS);
            return { ok: true, content: `exit ${commandResult.code}\n${output}` };
          }

          case "submit_result": {
            const schema = loadOrchestrationSchema("task-result");
            const { valid, errors } = validateAgainstSchema(args.result, schema);
            if (!valid) {
              return { ok: false, content: `ERROR: ${errors.join("; ")} — fix and resubmit` };
            }
            return { ok: true, content: "ok", submitted: args.result };
          }

          default:
            return { ok: false, content: `ERROR: unknown tool: ${name}` };
        }
      } catch (error) {
        return { ok: false, content: `ERROR: ${error.message}` };
      }
    }

    try {
      while (true) {
        if (entry.cancelRequested) {
          return finish("cancelled", "", null);
        }
        if (Date.now() > deadlineMs) {
          return finish("timeout", "", null);
        }

        onProgress?.({ message: "request sent", phase: "request", executionId });
        const { response, networkError } = await requestRound();

        if (networkError) {
          if (entry.cancelRequested) {
            return finish("cancelled", "", null);
          }
          return finish("failed", "", networkError.message);
        }

        if (!response.ok) {
          const bodyText = await readCappedErrorBody(response);
          return finish("failed", "", `chat/completions HTTP ${response.status}`, { lastHttpError: bodyText });
        }

        const payload = await response.json();
        if (payload && payload.usage) {
          anyUsageSeen = true;
          usageInputTokens = (usageInputTokens ?? 0) + (payload.usage.prompt_tokens ?? 0);
          usageOutputTokens = (usageOutputTokens ?? 0) + (payload.usage.completion_tokens ?? 0);
        }

        const message = payload?.choices?.[0]?.message ?? {};
        messages.push(message);

        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (calls.length === 0) {
          if (nudged) {
            return finish("failed", "", "model finished without submit_result");
          }
          nudged = true;
          messages.push({ role: "user", content: NUDGE_MESSAGE });
          continue;
        }

        for (const call of calls) {
          if (entry.cancelRequested) {
            return finish("cancelled", "", null);
          }
          if (Date.now() > deadlineMs) {
            return finish("timeout", "", null);
          }
          if (toolCalls.length + 1 > maxToolCalls) {
            return finish("failed", "", "tool call limit exceeded");
          }

          const name = call?.function?.name;
          const { ok: argsOk, args } = parseToolArguments(call?.function?.arguments);
          const dispatchResult = argsOk
            ? await dispatchTool(name, args)
            : { ok: false, content: "ERROR: invalid tool arguments" };

          toolCalls.push({
            tool: name,
            args,
            result: capString(dispatchResult.content, MAX_TOOL_CALL_RESULT_CHARS),
            ok: dispatchResult.ok
          });
          onProgress?.({ message: `tool call: ${name}`, phase: "tool", executionId });

          messages.push({ role: "tool", tool_call_id: call?.id, content: dispatchResult.content });

          if (name === "submit_result") {
            if (dispatchResult.ok) {
              return finish("completed", JSON.stringify(dispatchResult.submitted), null);
            }
            invalidSubmitCount += 1;
            if (invalidSubmitCount >= 2) {
              return finish("failed", "", "submit_result failed schema validation twice");
            }
          }
        }
      }
    } catch (error) {
      return finish("failed", "", error instanceof Error ? error.message : String(error));
    }
  }

  async function cancel(executionId) {
    const entry = executions.get(executionId);
    if (!entry || entry.state === "done") {
      return { attempted: false };
    }

    entry.cancelRequested = true;
    if (entry.controller) {
      entry.controller.abort();
    }
    return { attempted: true };
  }

  function getStatus(executionId) {
    const entry = executions.get(executionId);
    if (!entry) {
      return null;
    }
    return { executionId, state: entry.state };
  }

  return { execute, cancel, getStatus };
}
