import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";
import { renderMemoryForPrompt } from "./memory-store.mjs";
import { listProposals, applyDecision } from "./proposal-store.mjs";

/**
 * Manager-side decision-making for memory proposals. This module only
 * decides; it never mutates state itself. `createMemoryReviewer` builds a
 * `decide(proposal, options)` function backed by a manager runtime;
 * `reviewPendingProposals` drives that function over every pending proposal
 * and applies each decision via `applyDecision` (the only path that can
 * create a memory version), keeping decision-making and state mutation
 * separate.
 */

const PLUGIN_ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function buildPrompt(pluginRoot, proposal, taskContext, memoryEntries) {
  const template = loadPromptTemplate(pluginRoot, "orchestration/memory-decision");
  return interpolateTemplate(template, {
    PROPOSAL_JSON: JSON.stringify(proposal, null, 2),
    TASK_CONTEXT: taskContext ?? "",
    EXISTING_MEMORY: renderMemoryForPrompt(memoryEntries)
  });
}

function buildCorrectionPrompt(prompt, errors) {
  const errorList = errors.map((error) => `- ${error}`).join("\n");
  return `${prompt}\n\n## Correction required\nThe previous response failed validation with these errors:\n${errorList}\n\nReturn ONLY corrected JSON matching the schema.`;
}

function tryParseAndValidate(output, schema) {
  let parsed;
  try {
    parsed = JSON.parse(output ?? "");
  } catch (error) {
    return { ok: false, errors: [`Manager output was not parseable JSON: ${error.message}`] };
  }

  const { valid, errors } = validateAgainstSchema(parsed, schema);
  if (!valid) {
    return { ok: false, errors };
  }
  return { ok: true, value: parsed };
}

/**
 * Builds a `decide(proposal, { taskContext, memoryEntries })` function
 * backed by a manager runtime. Never applies the decision — the caller does
 * that via `applyDecision`, keeping decision-making and state mutation
 * separate. One schema-repair retry is attempted before giving up,
 * mirroring `review-loop.mjs`'s `createCodexReviewer`.
 *
 * @param {{ rootDir: string, runtime: { execute: Function }, managerAgent: object, pluginRoot?: string }} options
 */
export function createMemoryReviewer({ rootDir, runtime, managerAgent, pluginRoot = PLUGIN_ROOT_DIR } = {}) {
  return async function decide(proposal, { taskContext = "", memoryEntries = [] } = {}) {
    const schema = loadOrchestrationSchema("memory-decision");
    const prompt = buildPrompt(pluginRoot, proposal, taskContext, memoryEntries);
    const task = { taskId: proposal.taskId ?? "memory-review" };

    const firstRun = await runtime.execute(managerAgent, task, { prompt, outputSchema: schema });
    if (firstRun.status !== "completed") {
      throw new Error(`Memory review failed: ${firstRun.error ?? firstRun.status}`);
    }

    const firstTry = tryParseAndValidate(firstRun.output, schema);
    if (firstTry.ok) {
      return firstTry.value;
    }

    const retryPrompt = buildCorrectionPrompt(prompt, firstTry.errors);
    const secondRun = await runtime.execute(managerAgent, task, { prompt: retryPrompt, outputSchema: schema });
    if (secondRun.status !== "completed") {
      throw new Error(`Memory review failed: ${secondRun.error ?? secondRun.status}`);
    }

    const secondTry = tryParseAndValidate(secondRun.output, schema);
    if (secondTry.ok) {
      return secondTry.value;
    }

    throw new Error(`Memory decision invalid after one retry:\n${secondTry.errors.join("\n")}`);
  };
}

/**
 * Drives `decide` over every pending proposal (in proposalId order) and
 * applies each resulting decision via `applyDecision`. A `guards.beforeManagerCall`
 * throw stops processing immediately and returns what was processed so far
 * with `halted: true` — the same "budget guard before every manager call"
 * pattern as `runReviewLoop`.
 *
 * @param {string} rootDir
 * @param {{ campaignId: string, decide: Function, decidedBy: string, guards?: { beforeManagerCall?: Function } }} options
 * @returns {Promise<{ processed: { proposalId: string, action: string }[], halted: boolean }>}
 */
export async function reviewPendingProposals(rootDir, { campaignId, decide, decidedBy, guards = {} } = {}) {
  const pending = listProposals(rootDir, { status: "pending" });
  const processed = [];

  for (const proposal of pending) {
    try {
      await guards.beforeManagerCall?.(proposal);
    } catch {
      return { processed, halted: true };
    }

    const decision = await decide(proposal, {});
    applyDecision(rootDir, proposal.proposalId, decision, { campaignId, decidedBy });
    processed.push({ proposalId: proposal.proposalId, action: decision.action });
  }

  return { processed, halted: false };
}
