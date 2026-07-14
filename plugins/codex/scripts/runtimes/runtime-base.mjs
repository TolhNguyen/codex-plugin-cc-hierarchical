/**
 * Provider-agnostic runtime contract shared by every agent runtime (Codex
 * manager runtime today, the OpenAI-compatible worker runtime later). A
 * "runtime" is transport + execution bookkeeping only: it does not assemble
 * prompts and does not know about task routing or review policy.
 *
 * @typedef {{
 *   tool: string,
 *   args: object,
 *   result: string,
 *   ok: boolean
 * }} ToolCallRecord
 *
 * @typedef {{
 *   inputTokens: number | null,
 *   outputTokens: number | null,
 *   calls: number
 * }} UsageSummary
 *
 * @typedef {{
 *   executionId: string,
 *   agentId: string,
 *   role: "manager" | "worker",
 *   status: "completed" | "failed" | "cancelled" | "timeout",
 *   output: string,
 *   toolCalls: ToolCallRecord[],
 *   usage: UsageSummary,
 *   startedAt: string,
 *   endedAt: string,
 *   error: string | null
 * }} RuntimeResult
 */
import fs from "node:fs";
import path from "node:path";

import { generateJobId } from "../lib/state.mjs";

const STATUS_VALUES = ["completed", "failed", "cancelled", "timeout"];
const ROLE_VALUES = ["manager", "worker"];
const EXECUTIONS_DIRNAME = "executions";

function fail(field) {
  throw new Error(`Invalid RuntimeResult field: ${field}`);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail(field);
  }
}

/**
 * @returns {string} `exec-<time base36>-<6 random base36 chars>`, matching the
 * style of `generateJobId` in lib/state.mjs (which this reuses directly).
 */
export function generateExecutionId() {
  return generateJobId("exec");
}

/**
 * Validates and normalizes a RuntimeResult, filling in defaults for
 * `toolCalls`, `usage`, and `error`. Returns a frozen shallow copy so callers
 * cannot mutate a persisted execution record after the fact.
 *
 * @param {Partial<RuntimeResult>} fields
 * @returns {RuntimeResult}
 */
export function createRuntimeResult(fields = {}) {
  const {
    executionId,
    agentId,
    role,
    status,
    output,
    toolCalls = [],
    usage = {},
    startedAt,
    endedAt,
    error = null
  } = fields;

  requireNonEmptyString(executionId, "executionId");
  requireNonEmptyString(agentId, "agentId");
  requireNonEmptyString(startedAt, "startedAt");
  requireNonEmptyString(endedAt, "endedAt");

  if (!ROLE_VALUES.includes(role)) {
    fail("role");
  }

  if (!STATUS_VALUES.includes(status)) {
    fail("status");
  }

  if (typeof output !== "string") {
    fail("output");
  }

  const result = {
    executionId,
    agentId,
    role,
    status,
    output,
    toolCalls: Array.isArray(toolCalls) ? [...toolCalls] : [],
    usage: {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      calls: usage.calls ?? 0
    },
    startedAt,
    endedAt,
    error
  };

  return Object.freeze(result);
}

function executionsDir(rootDir) {
  return path.join(rootDir, ".ai-company", EXECUTIONS_DIRNAME);
}

function executionFilePath(rootDir, executionId) {
  return path.join(executionsDir(rootDir), `${executionId}.json`);
}

/**
 * Persists a RuntimeResult (plus any runtime-specific transcript data, e.g.
 * Codex threadId/turnId or raw provider messages) as pretty JSON under
 * `<rootDir>/.ai-company/executions/<executionId>.json`.
 *
 * @param {string} rootDir
 * @param {RuntimeResult} result
 * @param {object} [extra]
 * @returns {string} the written file path
 */
export function writeExecutionRecord(rootDir, result, extra = {}) {
  fs.mkdirSync(executionsDir(rootDir), { recursive: true });
  const filePath = executionFilePath(rootDir, result.executionId);
  const payload = { ...result, ...extra };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

/**
 * @param {string} rootDir
 * @param {string} executionId
 * @returns {object | null} the parsed record, or null if it does not exist.
 */
export function readExecutionRecord(rootDir, executionId) {
  const filePath = executionFilePath(rootDir, executionId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
