/**
 * Codex-backed manager runtime. Wraps the existing app-server turn transport
 * (`lib/codex.mjs`) behind the provider-agnostic runtime contract defined in
 * `runtime-base.mjs`. Manager runs are always read-only: this runtime never
 * accepts a writable sandbox from a caller.
 *
 * The runtime does not build prompts. Callers (the topology planner today,
 * the review loop later) own prompt assembly and pass the finished prompt in
 * via `context.prompt`.
 */
import { interruptAppServerTurn, runAppServerTurn } from "../lib/codex.mjs";
import { createRuntimeResult, generateExecutionId, writeExecutionRecord } from "./runtime-base.mjs";

const MANAGER_SANDBOX = "read-only";

function buildToolCalls(runResult) {
  const commandToolCalls = (runResult.commandExecutions ?? []).map((item) => ({
    tool: "run_command",
    args: { command: item.command },
    result: String(item.exitCode ?? ""),
    ok: item.exitCode === 0
  }));

  const fileChangeToolCalls = (runResult.fileChanges ?? []).map((item) => ({
    tool: "file_change",
    args: { changes: item.changes ?? [] },
    result: item.status ?? "",
    ok: item.status === "completed"
  }));

  return [...commandToolCalls, ...fileChangeToolCalls];
}

function resolveError(runResult, status) {
  return runResult.error?.message ?? (status === "failed" ? runResult.stderr || "codex turn failed" : null);
}

/**
 * @param {{
 *   rootDir: string,
 *   runTurn?: typeof runAppServerTurn,
 *   interruptTurn?: typeof interruptAppServerTurn,
 *   now?: () => string
 * }} [options]
 */
export function createCodexRuntime({
  rootDir,
  runTurn = runAppServerTurn,
  interruptTurn = interruptAppServerTurn,
  now = () => new Date().toISOString()
} = {}) {
  /** @type {Map<string, { state: "running" | "done", threadId: string | null, turnId: string | null }>} */
  const executions = new Map();

  async function execute(agent, task, context = {}) {
    const prompt = context.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("context.prompt is required and must be a non-empty string.");
    }

    const executionId = generateExecutionId();
    const startedAt = now();
    const entry = { state: "running", threadId: null, turnId: null };
    executions.set(executionId, entry);

    const wrappedOnProgress = (event) => {
      if (event && typeof event === "object") {
        if (event.threadId) {
          entry.threadId = event.threadId;
        }
        if (event.turnId) {
          entry.turnId = event.turnId;
        }
      }
      context.onProgress?.(event);
    };

    let runResult = null;
    let thrownError = null;
    try {
      runResult = await runTurn(rootDir, {
        prompt,
        model: agent?.runtime?.model ?? null,
        sandbox: MANAGER_SANDBOX,
        outputSchema: context.outputSchema ?? null,
        onProgress: wrappedOnProgress
      });
    } catch (error) {
      thrownError = error;
    }

    const endedAt = now();
    entry.state = "done";

    if (thrownError) {
      const failedResult = createRuntimeResult({
        executionId,
        agentId: agent.id,
        role: "manager",
        status: "failed",
        output: "",
        startedAt,
        endedAt,
        error: thrownError instanceof Error ? thrownError.message : String(thrownError)
      });
      writeExecutionRecord(rootDir, failedResult);
      return failedResult;
    }

    const status = runResult.status === 0 ? "completed" : "failed";
    const result = createRuntimeResult({
      executionId,
      agentId: agent.id,
      role: "manager",
      status,
      output: runResult.finalMessage ?? "",
      toolCalls: buildToolCalls(runResult),
      usage: { inputTokens: null, outputTokens: null, calls: 1 },
      startedAt,
      endedAt,
      error: resolveError(runResult, status)
    });

    writeExecutionRecord(rootDir, result, {
      threadId: runResult.threadId,
      turnId: runResult.turnId,
      reasoningSummary: runResult.reasoningSummary
    });

    return result;
  }

  async function cancel(executionId) {
    const entry = executions.get(executionId) ?? null;
    if (!entry || !entry.threadId || !entry.turnId) {
      return { attempted: false };
    }

    const interruptResult = await interruptTurn(rootDir, { threadId: entry.threadId, turnId: entry.turnId });
    return { attempted: true, ...interruptResult };
  }

  function getStatus(executionId) {
    const entry = executions.get(executionId) ?? null;
    if (!entry) {
      return null;
    }
    return {
      executionId,
      state: entry.state,
      threadId: entry.threadId,
      turnId: entry.turnId
    };
  }

  return { execute, cancel, getStatus };
}
