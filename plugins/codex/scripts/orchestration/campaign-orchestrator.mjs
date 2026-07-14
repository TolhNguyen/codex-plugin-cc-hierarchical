import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { readJsonFile, writeJsonFile } from "../lib/fs.mjs";
import { appendAuditEvent } from "./audit-log.mjs";
import { routeTask } from "./task-router.mjs";
import { createCodexReviewer, runReviewLoop } from "./review-loop.mjs";
import { createBudget } from "./budget.mjs";
import { recordProposals } from "../memory/proposal-store.mjs";
import { listMemoryEntries, renderMemoryForPrompt } from "../memory/memory-store.mjs";
import { assertSkillsActive } from "../skills/skill-registry.mjs";
import { createCodexRuntime } from "../runtimes/codex-runtime.mjs";
import { createOpenAICompatibleRuntime } from "../runtimes/openai-compatible-runtime.mjs";
import { createPermissionGuard } from "../agents/permission-guard.mjs";

/**
 * The campaign orchestrator: the top-level unit that wires task routing,
 * budget guards, the review loop, and the memory proposal flow together into
 * one runnable campaign. This module owns:
 *  - the campaign document lifecycle (create/load/save/list/status),
 *  - `buildWorkerContext`, the ONLY place worker prompts are assembled (a
 *    worker never sees the repo — only what this function hands it), and
 *  - `runCampaignTask`, which drives a single task through routing, the
 *    bounded review loop (budget-guarded), memory proposal recording, and
 *    campaign usage/status persistence. Budget exhaustion is expected,
 *    routine behavior here: it surfaces as a "halted" loop outcome and pauses
 *    the campaign — it never throws out of `runCampaignTask`.
 */

const DEFAULT_BUDGET = {
  maxExecutiveCalls: 5,
  maxManagerCalls: 30,
  maxWorkerCalls: 60,
  maxAttemptsPerTask: 3,
  maxCampaignDurationMinutes: 180
};

const MAX_CONTEXT_FILE_BYTES = 32 * 1024;

const HARD_RULES = [
  "- Stay strictly inside the paths listed under Affected paths below; do not touch anything else.",
  "- Only run commands that exactly match one of the Verification commands below.",
  "- You cannot edit `.ai-company/**` under any circumstance.",
  "- You cannot change the scope of this task (no new files/paths beyond Affected paths).",
  "- Finish by calling `submit_result` with a task-result document.",
  "- Any durable memory you want to keep must be proposed via `memoryProposals` in that " +
    "document — these are proposals only, not direct writes."
];

// --- campaign document lifecycle -----------------------------------------

function campaignDir(rootDir, campaignId) {
  return path.join(rootDir, ".ai-company", "campaigns", campaignId);
}

function campaignFilePath(rootDir, campaignId) {
  return path.join(campaignDir(rootDir, campaignId), "campaign.json");
}

function generateCampaignId() {
  const random = Math.random().toString(36).slice(2, 6);
  return `camp-${Date.now().toString(36)}-${random}`;
}

function validateCampaignDoc(campaign) {
  const schema = loadOrchestrationSchema("campaign");
  const { valid, errors } = validateAgainstSchema(campaign, schema);
  if (!valid) {
    throw new Error(`Invalid campaign:\n${errors.join("\n")}`);
  }
}

/**
 * @param {string} rootDir
 * @param {{ brief: string, acceptanceCriteria: string[], budget?: object }} options
 * @returns {object} the created, persisted campaign document
 */
export function createCampaign(rootDir, { brief, acceptanceCriteria, budget = {} } = {}) {
  const campaignId = generateCampaignId();

  const campaign = {
    campaignId,
    brief,
    acceptanceCriteria,
    status: "draft",
    budget: { ...DEFAULT_BUDGET, ...budget },
    usage: {
      executiveCalls: 0,
      managerCalls: 0,
      workerCalls: 0,
      reworks: 0,
      estimatedCostByProvider: {}
    },
    startedAt: new Date().toISOString()
  };

  validateCampaignDoc(campaign);
  fs.mkdirSync(campaignDir(rootDir, campaignId), { recursive: true });
  writeJsonFile(campaignFilePath(rootDir, campaignId), campaign);
  appendAuditEvent(rootDir, campaignId, { event: "campaign_created", campaignId });

  return campaign;
}

/**
 * @param {string} rootDir
 * @param {string} campaignId
 * @returns {object|null}
 */
export function loadCampaign(rootDir, campaignId) {
  const filePath = campaignFilePath(rootDir, campaignId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJsonFile(filePath);
}

/**
 * @param {string} rootDir
 * @param {object} campaign
 * @returns {object} the same campaign document, after validation
 */
export function saveCampaign(rootDir, campaign) {
  validateCampaignDoc(campaign);
  fs.mkdirSync(campaignDir(rootDir, campaign.campaignId), { recursive: true });
  writeJsonFile(campaignFilePath(rootDir, campaign.campaignId), campaign);
  return campaign;
}

/**
 * @param {string} rootDir
 * @returns {object[]} campaign documents sorted by campaignId
 */
export function listCampaigns(rootDir) {
  const dir = path.join(rootDir, ".ai-company", "campaigns");
  if (!fs.existsSync(dir)) {
    return [];
  }

  const campaigns = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const loaded = loadCampaign(rootDir, entry.name);
    if (loaded) {
      campaigns.push(loaded);
    }
  }

  return campaigns.sort((a, b) => String(a.campaignId).localeCompare(String(b.campaignId)));
}

const CAMPAIGN_STATUS_TRANSITIONS = {
  draft: ["awaiting_approval"],
  awaiting_approval: ["running"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled", "failed"]
};

/**
 * @param {string} rootDir
 * @param {string} campaignId
 * @param {string} status
 * @param {{ role: string, decision: string, at: string }|null} [approval]
 * @returns {object} the updated, persisted campaign document
 */
export function setCampaignStatus(rootDir, campaignId, status, approval = null) {
  const campaign = loadCampaign(rootDir, campaignId);
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  const from = campaign.status;
  const allowed = CAMPAIGN_STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(status)) {
    throw new Error(`Illegal campaign status transition: ${from} -> ${status}`);
  }

  if (from === "awaiting_approval" && status === "running") {
    if (!approval || !approval.role) {
      throw new Error(`Approval is required for campaign status transition: ${from} -> ${status}`);
    }
    campaign.approvals = [...(campaign.approvals ?? []), approval];
  }

  campaign.status = status;
  saveCampaign(rootDir, campaign);
  appendAuditEvent(rootDir, campaignId, { event: "campaign_status", from, to: status });

  return campaign;
}

// --- context assembly (the ONLY thing a worker ever sees) -----------------

function renderSkillBlock(skill) {
  const lines = [
    `### ${skill.id}@${skill.version}`,
    `Purpose: ${skill.purpose}`,
    `Use when: ${(skill.useWhen ?? []).join("; ") || "(none specified)"}`,
    "Procedure:",
    ...(skill.procedure ?? []).map((step, index) => `${index + 1}. ${step}`),
    `Verification steps: ${(skill.verificationSteps ?? []).join("; ") || "(none specified)"}`,
    `Done when: ${(skill.doneWhen ?? []).join("; ") || "(none specified)"}`,
    `Escalate when: ${(skill.escalateWhen ?? []).join("; ") || "(none specified)"}`,
    `Output contract: ${skill.outputContract}`
  ];
  return lines.join("\n");
}

// Every contextFiles read is routed through the agent's own permission guard
// (the same guard a worker's tool calls would be bound by) so a task naming
// a path outside rootDir or outside the agent's granted read globs (e.g.
// "../../.ssh/id_rsa" or ".ai-company/agents/x.json") can never leak file
// content — or even its resolved OS path — into the assembled prompt. A
// denied/escaping entry renders a neutral "(access denied)" note (same shape
// as the existing "(missing)" note) and does not abort the rest of context
// assembly.
function readContextFileBlock(guard, relPath) {
  let absPath;
  try {
    absPath = guard.assertRead(relPath);
  } catch {
    return `### ${relPath}\n(access denied)`;
  }

  let stats;
  try {
    stats = fs.statSync(absPath);
  } catch {
    return `### ${relPath}\n(missing)`;
  }
  if (!stats.isFile()) {
    return `### ${relPath}\n(missing)`;
  }
  if (stats.size > MAX_CONTEXT_FILE_BYTES) {
    return `### ${relPath}\n(too large)`;
  }

  const buffer = fs.readFileSync(absPath);
  return `### ${relPath}\n${buffer.toString("utf8")}`;
}

function buildIdentityBlock(agent) {
  const lines = [
    `You are agent \`${agent.id}\` (${agent.name}).`,
    "Responsibilities:",
    ...(agent.responsibilities ?? []).map((item) => `- ${item}`)
  ];
  return lines.join("\n");
}

function buildUserPrompt(task, contextBlocks, feedback) {
  const lines = [
    `## Task: ${task.title}`,
    task.goal,
    "",
    "## Acceptance criteria",
    ...(task.acceptanceCriteria ?? []).map((item) => `- ${item}`),
    "",
    "## Affected paths",
    ...(task.affectedPaths ?? []).map((item) => `- ${item}`),
    "",
    "## Verification commands",
    ...(task.verificationCommands ?? []).map((item) => `- ${item}`)
  ];

  if (contextBlocks.length > 0) {
    lines.push("", "## Context files", ...contextBlocks);
  }

  if (Array.isArray(feedback) && feedback.length > 0) {
    lines.push(
      "",
      "## Reviewer feedback",
      ...feedback.map((item) => `- [${item.code}] ${item.description}`)
    );
  }

  return lines.join("\n");
}

/**
 * Assembles the ONLY context a worker ever receives: agent identity, its
 * ACTIVE granted skills, memory from ONLY its granted namespaces, the
 * task's context files (capped, missing-safe), and hard scope rules. Never
 * the repo itself.
 *
 * @param {string} rootDir
 * @param {object} task a task document (validated by `routeTask` upstream)
 * @param {object} agent the owning agent document
 * @param {{ code: string, description: string }[]} [feedback] reviewer
 *   feedback from a prior attempt; a non-empty array implies attempt > 1.
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildWorkerContext(rootDir, task, agent, feedback = []) {
  const skills = assertSkillsActive(rootDir, task.requiredSkills ?? []);
  const skillsBlock = skills.map(renderSkillBlock).join("\n\n") || "(no active skills)";

  const memoryEntries = listMemoryEntries(rootDir, agent?.memory?.namespaces ?? []);
  const memoryBlock = renderMemoryForPrompt(memoryEntries);

  const guard = createPermissionGuard(rootDir, agent?.permissions ?? {});
  const contextBlocks = (task.contextFiles ?? []).map((relPath) => readContextFileBlock(guard, relPath));

  const systemPrompt = [
    buildIdentityBlock(agent),
    "",
    "## Active skills",
    skillsBlock,
    "",
    "## Memory",
    memoryBlock,
    "",
    "## Hard rules",
    ...HARD_RULES
  ].join("\n");

  const userPrompt = buildUserPrompt(task, contextBlocks, feedback);

  return { systemPrompt, userPrompt };
}

// --- running a task within a campaign --------------------------------------

function tryParseTaskResult(output) {
  try {
    return JSON.parse(output ?? "");
  } catch {
    return null;
  }
}

/**
 * Routes, then runs, a single task within a campaign: budget guards are
 * consulted before every worker/manager call via the review loop; budget
 * exhaustion is surfaced as loop outcome "halted" and pauses the campaign
 * (never throws, never crashes, never silently continues). On approval, any
 * `memoryProposals` in the worker's task-result are recorded as pending
 * proposals (never written directly). Campaign usage is updated and
 * persisted regardless of outcome.
 *
 * @param {string} rootDir
 * @param {{
 *   campaign: object,
 *   task: object,
 *   managerAgent: object,
 *   workerRuntimeFactory?: Function,
 *   managerRuntimeFactory?: Function,
 *   env?: object
 * }} options
 * @returns {Promise<{ routing: object, loop: object, proposals: { stored: object[], rejected: object[] } }>}
 */
export async function runCampaignTask(
  rootDir,
  {
    campaign,
    task,
    managerAgent,
    workerRuntimeFactory = createOpenAICompatibleRuntime,
    managerRuntimeFactory = createCodexRuntime,
    env = process.env
  }
) {
  // Code-level approval gate: a campaign that was never approved (or was
  // paused, or already finished) must never spend real budget on a task run
  // — the "draft -> awaiting_approval -> running" state machine is otherwise
  // only prose. This check must run before routing/budget/any runtime call.
  if (campaign.status !== "running") {
    throw new Error(
      `Campaign ${campaign.campaignId} is not running (status: ${campaign.status}). ` +
        "Run `campaign approve --approved-by <role>` to approve it before running tasks."
    );
  }

  const routing = routeTask(rootDir, task, {});

  if (routing.writeGaps.length > 0) {
    appendAuditEvent(rootDir, campaign.campaignId, {
      event: "routing_write_gaps",
      taskId: task.taskId,
      agentId: routing.owner.id,
      writeGaps: routing.writeGaps
    });
  }

  const budget = createBudget(campaign);

  // Wrap both runtimes so EVERY runtime result they ever produce (every
  // worker attempt, every manager review call including the schema-repair
  // retry inside createCodexReviewer) contributes to estimated cost — not
  // just the final worker attempt. `budget` stays pure/IO-free; only usage
  // bookkeeping happens here.
  function wrapRuntimeForCost(runtime, providerId) {
    return {
      ...runtime,
      execute: async (...args) => {
        const result = await runtime.execute(...args);
        if (result?.usage) {
          budget.estimateCost(providerId, result.usage);
        }
        return result;
      }
    };
  }

  const workerRuntime = wrapRuntimeForCost(
    workerRuntimeFactory({ rootDir, env }),
    routing.owner?.runtime?.provider ?? "unknown"
  );
  const managerRuntime = wrapRuntimeForCost(managerRuntimeFactory({ rootDir }), "codex");
  const reviewFn = createCodexReviewer({ rootDir, runtime: managerRuntime, managerAgent });

  const guards = {
    beforeWorkerCall: () => budget.guards.beforeWorkerCall(),
    beforeManagerCall: () => budget.guards.beforeManagerCall()
  };

  // `campaign.budget.maxAttemptsPerTask` must further cap the loop's attempt
  // budget (on top of task.maxAttempts and agent.limits.maxAttemptsPerTask,
  // which review-loop.mjs already combines) without modifying review-loop.mjs
  // itself — so clamp it into the task object handed to the loop.
  const taskForLoop = {
    ...task,
    maxAttempts: Math.min(task.maxAttempts, campaign.budget.maxAttemptsPerTask)
  };

  const loop = await runReviewLoop(rootDir, {
    campaignId: campaign.campaignId,
    task: taskForLoop,
    agent: routing.owner,
    workerRuntime,
    reviewFn,
    buildWorkerContext: (t, a, fb) => buildWorkerContext(rootDir, t, a, fb),
    guards
  });

  // Every attempt after the first was preceded by a rework decision (either
  // a real manager "rework" or a synthesized one after a transport
  // failure) — see review-loop.mjs's `synthesizeTransportDecision`.
  const reworkCount = Math.max(0, (loop.attempts ?? 0) - 1);
  for (let index = 0; index < reworkCount; index += 1) {
    budget.recordRework();
  }

  // Cost is already accounted for every runtime call via wrapRuntimeForCost
  // above (worker attempts + manager review calls, including reworks and the
  // schema-repair retry) — no further estimateCost call is needed here.
  let proposals = { stored: [], rejected: [] };
  if (loop.lastResult) {
    const parsedResult = tryParseTaskResult(loop.lastResult.output);
    if (parsedResult && Array.isArray(parsedResult.memoryProposals) && parsedResult.memoryProposals.length > 0) {
      proposals = recordProposals(rootDir, {
        campaignId: campaign.campaignId,
        taskId: task.taskId,
        agentId: routing.owner.id,
        proposals: parsedResult.memoryProposals
      });
    }
  }

  saveCampaign(rootDir, campaign);

  if (loop.outcome === "halted") {
    try {
      setCampaignStatus(rootDir, campaign.campaignId, "paused");
    } catch {
      // The campaign wasn't in a state (e.g. "running") from which "paused"
      // is a legal transition. Never let that crash task execution — the
      // budget_paused audit event below still records why we stopped.
    }
    appendAuditEvent(rootDir, campaign.campaignId, {
      event: "campaign_paused_budget",
      taskId: task.taskId,
      reason: loop.reason ?? null
    });
  }

  return { routing, loop, proposals };
}
