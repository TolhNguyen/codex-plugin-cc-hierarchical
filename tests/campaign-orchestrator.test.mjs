import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCampaign,
  loadCampaign,
  saveCampaign,
  listCampaigns,
  setCampaignStatus,
  buildWorkerContext,
  runCampaignTask
} from "../plugins/codex/scripts/orchestration/campaign-orchestrator.mjs";
import { readAuditEvents } from "../plugins/codex/scripts/orchestration/audit-log.mjs";
import { createRuntimeResult } from "../plugins/codex/scripts/runtimes/runtime-base.mjs";
import { saveAgent } from "../plugins/codex/scripts/agents/agent-registry.mjs";
import { saveSkill } from "../plugins/codex/scripts/skills/skill-registry.mjs";
import { appendMemoryEntry } from "../plugins/codex/scripts/memory/memory-store.mjs";
import { recordProposals } from "../plugins/codex/scripts/memory/proposal-store.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "plugins", "codex", "scripts", "orchestration-cli.mjs");

function withTempDir(fn) {
  const rootDir = makeTempDir("campaign-orchestrator-test-");
  try {
    fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn) {
  const rootDir = makeTempDir("campaign-orchestrator-test-");
  try {
    await fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function makeSkillDoc(overrides = {}) {
  return {
    id: "technical/shared-skill",
    version: "1.0.0",
    status: "active",
    purpose: "Do the shared thing.",
    useWhen: ["when doing the thing"],
    dontUseWhen: [],
    requiredInputs: [],
    procedure: ["Step 1", "Step 2"],
    verificationSteps: ["run tests"],
    doneWhen: ["tests pass"],
    escalateWhen: ["tests fail twice"],
    outputContract: "task-result",
    sources: [],
    owner: "manager-codex",
    ...overrides
  };
}

function makeAgentDoc(overrides = {}) {
  return {
    id: "worker-a",
    name: "Worker A",
    type: "persistent",
    status: "active",
    ownership: { primary: ["src/alpha/**"], secondary: [], excluded: [] },
    responsibilities: ["do work", "keep tests green"],
    skills: ["technical/shared-skill@1.0.0"],
    memory: { namespaces: ["agent/worker-a", "project/shared"] },
    permissions: { read: ["**"], write: ["src/alpha/**"] },
    runtime: { provider: "openai-compatible", model: "deepseek-chat" },
    limits: { maxAttemptsPerTask: 3, maxExecutionMinutes: 20, maxToolCalls: 40 },
    ...overrides
  };
}

function makeTaskDoc(overrides = {}) {
  return {
    taskId: "task-1",
    campaignId: "camp-1",
    title: "Add a test",
    goal: "Extend coverage for the alpha module.",
    affectedPaths: ["src/alpha/file.js"],
    requiredSkills: ["technical/shared-skill@1.0.0"],
    owner: "worker-a",
    verificationCommands: ["npm test"],
    acceptanceCriteria: ["it works"],
    maxAttempts: 3,
    status: "routed",
    ...overrides
  };
}

function makeTaskResultDoc(overrides = {}) {
  return {
    taskId: "task-1",
    agentId: "worker-a",
    summary: "Added a test",
    status: "completed",
    changedFiles: ["tests/example.test.mjs"],
    commandsExecuted: ["npm test"],
    verification: { passed: true, details: "npm test passed" },
    risks: [],
    memoryProposals: [],
    skillProposals: [],
    ...overrides
  };
}

// --- createCampaign / loadCampaign / listCampaigns ------------------------

test("createCampaign: validates, persists, audits, and merges budget defaults over caller overrides", () => {
  withTempDir((rootDir) => {
    const campaign = createCampaign(rootDir, {
      brief: "Improve test coverage",
      acceptanceCriteria: ["coverage improves"],
      budget: { maxWorkerCalls: 10 }
    });

    assert.match(campaign.campaignId, /^camp-[0-9a-z]+-[0-9a-z]{4}$/);
    assert.equal(campaign.status, "draft");
    assert.deepEqual(campaign.usage, {
      executiveCalls: 0,
      managerCalls: 0,
      workerCalls: 0,
      reworks: 0,
      estimatedCostByProvider: {}
    });
    assert.deepEqual(campaign.budget, {
      maxExecutiveCalls: 5,
      maxManagerCalls: 30,
      maxWorkerCalls: 10,
      maxAttemptsPerTask: 3,
      maxCampaignDurationMinutes: 180
    });
    assert.ok(typeof campaign.startedAt === "string" && campaign.startedAt.length > 0);

    const filePath = path.join(rootDir, ".ai-company", "campaigns", campaign.campaignId, "campaign.json");
    assert.ok(fs.existsSync(filePath));
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), campaign);

    const loaded = loadCampaign(rootDir, campaign.campaignId);
    assert.deepEqual(loaded, campaign);

    const events = readAuditEvents(rootDir, campaign.campaignId);
    assert.ok(events.some((event) => event.event === "campaign_created"));
  });
});

test("createCampaign: uses full defaults when no budget overrides are given", () => {
  withTempDir((rootDir) => {
    const campaign = createCampaign(rootDir, { brief: "b", acceptanceCriteria: ["x"] });
    assert.deepEqual(campaign.budget, {
      maxExecutiveCalls: 5,
      maxManagerCalls: 30,
      maxWorkerCalls: 60,
      maxAttemptsPerTask: 3,
      maxCampaignDurationMinutes: 180
    });
  });
});

test("loadCampaign: returns null for an unknown campaignId", () => {
  withTempDir((rootDir) => {
    assert.equal(loadCampaign(rootDir, "camp-unknown"), null);
  });
});

test("listCampaigns: returns campaigns sorted by campaignId", () => {
  withTempDir((rootDir) => {
    const a = createCampaign(rootDir, { brief: "a", acceptanceCriteria: ["x"] });
    const b = createCampaign(rootDir, { brief: "b", acceptanceCriteria: ["y"] });

    const listed = listCampaigns(rootDir);
    assert.deepEqual(
      listed.map((campaign) => campaign.campaignId),
      [a.campaignId, b.campaignId].sort()
    );
  });
});

// --- setCampaignStatus -----------------------------------------------------

test("setCampaignStatus: legal transitions succeed, persist, and are audited", () => {
  withTempDir((rootDir) => {
    const campaign = createCampaign(rootDir, { brief: "a", acceptanceCriteria: ["x"] });

    setCampaignStatus(rootDir, campaign.campaignId, "awaiting_approval");
    const approval = { role: "exec-tin", decision: "approve", at: "2026-07-14T00:00:00.000Z" };
    const running = setCampaignStatus(rootDir, campaign.campaignId, "running", approval);
    assert.equal(running.status, "running");
    assert.deepEqual(running.approvals, [approval]);

    setCampaignStatus(rootDir, campaign.campaignId, "paused");
    setCampaignStatus(rootDir, campaign.campaignId, "running");
    const completed = setCampaignStatus(rootDir, campaign.campaignId, "completed");
    assert.equal(completed.status, "completed");

    const persisted = loadCampaign(rootDir, campaign.campaignId);
    assert.equal(persisted.status, "completed");

    const events = readAuditEvents(rootDir, campaign.campaignId);
    assert.equal(events.filter((event) => event.event === "campaign_status").length, 5);
  });
});

test("setCampaignStatus: illegal transitions throw and do not mutate the persisted campaign", () => {
  withTempDir((rootDir) => {
    const campaign = createCampaign(rootDir, { brief: "a", acceptanceCriteria: ["x"] });

    assert.throws(
      () => setCampaignStatus(rootDir, campaign.campaignId, "running"),
      /Illegal campaign status transition: draft -> running/
    );
    assert.throws(
      () => setCampaignStatus(rootDir, campaign.campaignId, "completed"),
      /Illegal campaign status transition/
    );

    const persisted = loadCampaign(rootDir, campaign.campaignId);
    assert.equal(persisted.status, "draft");
  });
});

test("setCampaignStatus: awaiting_approval -> running requires an approval record", () => {
  withTempDir((rootDir) => {
    const campaign = createCampaign(rootDir, { brief: "a", acceptanceCriteria: ["x"] });
    setCampaignStatus(rootDir, campaign.campaignId, "awaiting_approval");

    assert.throws(
      () => setCampaignStatus(rootDir, campaign.campaignId, "running"),
      /Approval is required/
    );
    assert.throws(
      () => setCampaignStatus(rootDir, campaign.campaignId, "running", {}),
      /Approval is required/
    );
  });
});

// --- buildWorkerContext: the context-assembly invariant --------------------

test("buildWorkerContext: includes only granted ACTIVE skills, memory from granted namespaces only, present + missing context files, and hard rules", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkillDoc());

    appendMemoryEntry(rootDir, "agent/worker-a", {
      content: "Agent-specific note",
      type: "convention",
      sourceProposalId: "MEM-PROP-a",
      agentId: "worker-a"
    });
    appendMemoryEntry(rootDir, "project/shared", {
      content: "Shared project note",
      type: "fact",
      sourceProposalId: "MEM-PROP-b",
      agentId: "worker-a"
    });
    // Namespace NOT granted to this agent — must never appear in the context.
    appendMemoryEntry(rootDir, "domain/forbidden", {
      content: "SECRET_NOT_GRANTED_CONTENT",
      type: "fact",
      sourceProposalId: "MEM-PROP-c",
      agentId: "other-agent"
    });

    fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "docs", "context.md"), "Some context content", "utf8");

    const agent = makeAgentDoc();
    const task = makeTaskDoc({ contextFiles: ["docs/context.md", "docs/missing.md"] });

    const context = buildWorkerContext(rootDir, task, agent, []);

    assert.match(context.systemPrompt, /worker-a/);
    assert.match(context.systemPrompt, /technical\/shared-skill@1\.0\.0/);
    assert.match(context.systemPrompt, /Agent-specific note/);
    assert.match(context.systemPrompt, /Shared project note/);
    assert.doesNotMatch(context.systemPrompt, /SECRET_NOT_GRANTED_CONTENT/);
    assert.doesNotMatch(context.userPrompt, /SECRET_NOT_GRANTED_CONTENT/);

    assert.match(context.userPrompt, /Some context content/);
    assert.match(context.userPrompt, /docs\/missing\.md/);
    assert.match(context.userPrompt, /\(missing\)/);

    assert.match(context.systemPrompt, /cannot edit `\.ai-company\/\*\*`/);
    assert.match(context.systemPrompt, /submit_result/);
    assert.match(context.systemPrompt, /memoryProposals/);
  });
});

test("buildWorkerContext: contextFiles that escape rootDir or fall outside the agent's granted read permissions are denied via the permission guard (no content or path leak) — Critical 1", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkillDoc());

    const outsideDir = makeTempDir("campaign-orchestrator-outside-");
    try {
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET_OUTSIDE_ROOTDIR_CONTENT", "utf8");
      const outsideRelPath = path.relative(rootDir, path.join(outsideDir, "secret.txt"));

      fs.mkdirSync(path.join(rootDir, ".ai-company", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, ".ai-company", "agents", "worker-a.json"),
        JSON.stringify({ secret: "SECRET_AI_COMPANY_CONTENT" }),
        "utf8"
      );

      fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
      fs.writeFileSync(path.join(rootDir, "docs", "context.md"), "Some context content", "utf8");

      // Scoped read permission (realistic worker grant): does NOT include
      // .ai-company or anything outside rootDir.
      const agent = makeAgentDoc({ permissions: { read: ["docs/**"], write: ["src/alpha/**"] } });
      const task = makeTaskDoc({
        contextFiles: [outsideRelPath, ".ai-company/agents/worker-a.json", "docs/context.md"]
      });

      const context = buildWorkerContext(rootDir, task, agent, []);

      assert.doesNotMatch(context.systemPrompt, /SECRET_OUTSIDE_ROOTDIR_CONTENT/);
      assert.doesNotMatch(context.userPrompt, /SECRET_OUTSIDE_ROOTDIR_CONTENT/);
      assert.doesNotMatch(context.systemPrompt, /SECRET_AI_COMPANY_CONTENT/);
      assert.doesNotMatch(context.userPrompt, /SECRET_AI_COMPANY_CONTENT/);

      const outsideDirPattern = new RegExp(outsideDir.replace(/[\\/]/g, "[\\\\/]"));
      assert.doesNotMatch(context.userPrompt, outsideDirPattern);
      assert.doesNotMatch(context.systemPrompt, outsideDirPattern);

      const accessDeniedCount = (context.userPrompt.match(/\(access denied\)/g) ?? []).length;
      assert.equal(accessDeniedCount, 2);
      assert.match(context.userPrompt, /Some context content/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test("buildWorkerContext: a contextFiles entry larger than the 32KB render cap is skipped with a (too large) note, never read into the prompt — Minor 7", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkillDoc());

    fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    const bigContent = `START_MARKER${"x".repeat(64 * 1024)}END_MARKER`;
    fs.writeFileSync(path.join(rootDir, "docs", "big.md"), bigContent, "utf8");

    const agent = makeAgentDoc({ permissions: { read: ["docs/**"], write: ["src/alpha/**"] } });
    const task = makeTaskDoc({ contextFiles: ["docs/big.md"] });

    const context = buildWorkerContext(rootDir, task, agent, []);

    assert.doesNotMatch(context.userPrompt, /START_MARKER/);
    assert.doesNotMatch(context.userPrompt, /END_MARKER/);
    assert.match(context.userPrompt, /docs\/big\.md\n\(too large\)/);
  });
});

test("buildWorkerContext: throws when a required skill is not active (assertSkillsActive enforced)", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkillDoc({ status: "draft" }));
    const agent = makeAgentDoc();
    const task = makeTaskDoc();

    assert.throws(() => buildWorkerContext(rootDir, task, agent, []), /not active/i);
  });
});

test("buildWorkerContext: renders a Reviewer feedback section only when feedback is non-empty (attempt > 1)", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    const agent = makeAgentDoc();
    const task = makeTaskDoc();

    const firstAttempt = buildWorkerContext(rootDir, task, agent, []);
    assert.doesNotMatch(firstAttempt.userPrompt, /Reviewer feedback/);

    const feedback = [{ code: "MISSING_TESTS", description: "add a test for Y" }];
    const secondAttempt = buildWorkerContext(rootDir, task, agent, feedback);
    assert.match(secondAttempt.userPrompt, /## Reviewer feedback/);
    assert.match(secondAttempt.userPrompt, /MISSING_TESTS/);
    assert.match(secondAttempt.userPrompt, /add a test for Y/);
  });
});

// --- runCampaignTask -------------------------------------------------------

test("runCampaignTask: happy path stores a pending memory proposal, updates usage, and audits the expected sequence", async () => {
  await withTempDirAsync(async (rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    saveAgent(rootDir, makeAgentDoc());

    const campaign = createCampaign(rootDir, {
      brief: "Improve test coverage",
      acceptanceCriteria: ["tests pass"],
      budget: { maxWorkerCalls: 5, maxManagerCalls: 5 }
    });
    campaign.status = "running";
    saveCampaign(rootDir, campaign);

    const task = makeTaskDoc({ campaignId: campaign.campaignId });

    const taskResultDoc = makeTaskResultDoc({
      memoryProposals: [
        {
          scope: "agent/worker-a",
          type: "convention",
          content: "Always assert exit codes.",
          evidence: ["task-1 revealed a silent failure"],
          confidence: 0.9
        }
      ]
    });

    const workerResult = createRuntimeResult({
      executionId: "exec-worker-1",
      agentId: "worker-a",
      role: "worker",
      status: "completed",
      output: JSON.stringify(taskResultDoc),
      usage: { inputTokens: 500, outputTokens: 200, calls: 1 },
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:05.000Z"
    });

    const reviewDecision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 2, maxAttempts: 3 };
    const managerResult = createRuntimeResult({
      executionId: "exec-mgr-1",
      agentId: "manager-codex",
      role: "manager",
      status: "completed",
      output: JSON.stringify(reviewDecision),
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:01.000Z"
    });

    const workerRuntimeFactory = () => ({ execute: async () => workerResult });
    const managerRuntimeFactory = () => ({ execute: async () => managerResult });
    const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };

    const result = await runCampaignTask(rootDir, {
      campaign,
      task,
      managerAgent,
      workerRuntimeFactory,
      managerRuntimeFactory
    });

    assert.equal(result.loop.outcome, "approved");
    assert.equal(result.routing.owner.id, "worker-a");
    assert.equal(result.proposals.stored.length, 1);
    assert.equal(result.proposals.rejected.length, 0);
    assert.equal(result.proposals.stored[0].status, "pending");

    const persistedCampaign = loadCampaign(rootDir, campaign.campaignId);
    assert.equal(persistedCampaign.usage.workerCalls, 1);
    assert.equal(persistedCampaign.usage.managerCalls, 1);
    assert.equal(persistedCampaign.usage.reworks, 0);
    assert.ok("openai-compatible" in persistedCampaign.usage.estimatedCostByProvider);

    const events = readAuditEvents(rootDir, campaign.campaignId);
    const eventNames = events.map((event) => event.event);
    assert.ok(eventNames.includes("task_attempt_started"));
    assert.ok(eventNames.includes("worker_result"));
    assert.ok(eventNames.includes("review_decision"));
    assert.ok(eventNames.includes("loop_finished"));
    assert.ok(eventNames.includes("memory_proposal_recorded"));
  });
});

test("runCampaignTask: maxWorkerCalls = 0 halts the loop, pauses the campaign, and audits campaign_paused_budget without crashing", async () => {
  await withTempDirAsync(async (rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    saveAgent(rootDir, makeAgentDoc());

    const campaign = createCampaign(rootDir, {
      brief: "Improve test coverage",
      acceptanceCriteria: ["tests pass"],
      budget: { maxWorkerCalls: 0 }
    });
    campaign.status = "running";
    saveCampaign(rootDir, campaign);

    const task = makeTaskDoc({ campaignId: campaign.campaignId });

    const workerRuntimeFactory = () => ({
      execute: async () => {
        throw new Error("worker should never be called: budget is exhausted");
      }
    });
    const managerRuntimeFactory = () => ({
      execute: async () => {
        throw new Error("manager should never be called: budget is exhausted");
      }
    });
    const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };

    const result = await runCampaignTask(rootDir, {
      campaign,
      task,
      managerAgent,
      workerRuntimeFactory,
      managerRuntimeFactory
    });

    assert.equal(result.loop.outcome, "halted");
    assert.deepEqual(result.proposals, { stored: [], rejected: [] });

    const persistedCampaign = loadCampaign(rootDir, campaign.campaignId);
    assert.equal(persistedCampaign.status, "paused");

    const events = readAuditEvents(rootDir, campaign.campaignId);
    assert.ok(events.some((event) => event.event === "campaign_paused_budget"));
  });
});

test("runCampaignTask: a worker transport failure then a successful retry increments usage.reworks", async () => {
  await withTempDirAsync(async (rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    saveAgent(rootDir, makeAgentDoc());

    const campaign = createCampaign(rootDir, {
      brief: "Improve test coverage",
      acceptanceCriteria: ["tests pass"],
      budget: { maxWorkerCalls: 5, maxManagerCalls: 5 }
    });
    campaign.status = "running";
    saveCampaign(rootDir, campaign);

    const task = makeTaskDoc({ campaignId: campaign.campaignId, maxAttempts: 3 });

    const failedResult = createRuntimeResult({
      executionId: "exec-worker-fail",
      agentId: "worker-a",
      role: "worker",
      status: "failed",
      output: "",
      error: "network down",
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:01.000Z"
    });

    const successResult = createRuntimeResult({
      executionId: "exec-worker-success",
      agentId: "worker-a",
      role: "worker",
      status: "completed",
      output: JSON.stringify(makeTaskResultDoc()),
      startedAt: "2026-07-14T00:00:02.000Z",
      endedAt: "2026-07-14T00:00:03.000Z"
    });

    let workerCall = 0;
    const workerRuntimeFactory = () => ({
      execute: async () => {
        workerCall += 1;
        return workerCall === 1 ? failedResult : successResult;
      }
    });

    const reviewDecision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 3, maxAttempts: 3 };
    const managerResult = createRuntimeResult({
      executionId: "exec-mgr-1",
      agentId: "manager-codex",
      role: "manager",
      status: "completed",
      output: JSON.stringify(reviewDecision),
      startedAt: "2026-07-14T00:00:02.500Z",
      endedAt: "2026-07-14T00:00:03.500Z"
    });
    const managerRuntimeFactory = () => ({ execute: async () => managerResult });
    const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };

    const result = await runCampaignTask(rootDir, {
      campaign,
      task,
      managerAgent,
      workerRuntimeFactory,
      managerRuntimeFactory
    });

    assert.equal(result.loop.outcome, "approved");
    assert.equal(result.loop.attempts, 2);

    const persistedCampaign = loadCampaign(rootDir, campaign.campaignId);
    assert.equal(persistedCampaign.usage.reworks, 1);
  });
});

test("runCampaignTask: rejects when campaign.status is 'draft' and never invokes the worker or manager runtime — Critical 2", async () => {
  await withTempDirAsync(async (rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    saveAgent(rootDir, makeAgentDoc());

    const campaign = createCampaign(rootDir, { brief: "b", acceptanceCriteria: ["x"] });
    const task = makeTaskDoc({ campaignId: campaign.campaignId });

    let workerCalled = false;
    let managerCalled = false;
    const workerRuntimeFactory = () => ({
      execute: async () => {
        workerCalled = true;
        throw new Error("worker must never be called before approval");
      }
    });
    const managerRuntimeFactory = () => ({
      execute: async () => {
        managerCalled = true;
        throw new Error("manager must never be called before approval");
      }
    });
    const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };

    await assert.rejects(
      () => runCampaignTask(rootDir, { campaign, task, managerAgent, workerRuntimeFactory, managerRuntimeFactory }),
      /draft/
    );
    assert.equal(workerCalled, false);
    assert.equal(managerCalled, false);
  });
});

test("runCampaignTask: rejects when campaign.status is 'awaiting_approval' and never invokes any runtime — Critical 2", async () => {
  await withTempDirAsync(async (rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    saveAgent(rootDir, makeAgentDoc());

    const campaign = createCampaign(rootDir, { brief: "b", acceptanceCriteria: ["x"] });
    setCampaignStatus(rootDir, campaign.campaignId, "awaiting_approval");
    const pendingCampaign = loadCampaign(rootDir, campaign.campaignId);
    const task = makeTaskDoc({ campaignId: campaign.campaignId });

    let workerCalled = false;
    let managerCalled = false;
    const workerRuntimeFactory = () => ({ execute: async () => { workerCalled = true; throw new Error("must not be called"); } });
    const managerRuntimeFactory = () => ({ execute: async () => { managerCalled = true; throw new Error("must not be called"); } });
    const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };

    await assert.rejects(
      () =>
        runCampaignTask(rootDir, {
          campaign: pendingCampaign,
          task,
          managerAgent,
          workerRuntimeFactory,
          managerRuntimeFactory
        }),
      /awaiting_approval/
    );
    assert.equal(workerCalled, false);
    assert.equal(managerCalled, false);
  });
});

test("runCampaignTask: rejects when campaign.status is 'paused' and never invokes any runtime — Critical 2", async () => {
  await withTempDirAsync(async (rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    saveAgent(rootDir, makeAgentDoc());

    const campaign = createCampaign(rootDir, { brief: "b", acceptanceCriteria: ["x"] });
    setCampaignStatus(rootDir, campaign.campaignId, "awaiting_approval");
    setCampaignStatus(rootDir, campaign.campaignId, "running", {
      role: "exec-tin",
      decision: "approve",
      at: new Date().toISOString()
    });
    const pausedCampaign = setCampaignStatus(rootDir, campaign.campaignId, "paused");
    const task = makeTaskDoc({ campaignId: campaign.campaignId });

    let workerCalled = false;
    let managerCalled = false;
    const workerRuntimeFactory = () => ({ execute: async () => { workerCalled = true; throw new Error("must not be called"); } });
    const managerRuntimeFactory = () => ({ execute: async () => { managerCalled = true; throw new Error("must not be called"); } });
    const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };

    await assert.rejects(
      () =>
        runCampaignTask(rootDir, {
          campaign: pausedCampaign,
          task,
          managerAgent,
          workerRuntimeFactory,
          managerRuntimeFactory
        }),
      /paused/
    );
    assert.equal(workerCalled, false);
    assert.equal(managerCalled, false);
  });
});

test("runCampaignTask: estimates manager (codex) cost too, and accumulates worker cost across every attempt, not just the last — Important 3", async () => {
  await withTempDirAsync(async (rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    saveAgent(rootDir, makeAgentDoc({ runtime: { provider: "deepseek", model: "deepseek-chat" } }));

    const campaign = createCampaign(rootDir, {
      brief: "b",
      acceptanceCriteria: ["x"],
      budget: { maxWorkerCalls: 5, maxManagerCalls: 5 }
    });
    campaign.status = "running";
    saveCampaign(rootDir, campaign);

    const task = makeTaskDoc({ campaignId: campaign.campaignId, maxAttempts: 3 });

    const workerUsage = { inputTokens: 1000, outputTokens: 1000, calls: 1 };
    const workerResult1 = createRuntimeResult({
      executionId: "exec-w1",
      agentId: "worker-a",
      role: "worker",
      status: "completed",
      output: JSON.stringify(makeTaskResultDoc()),
      usage: workerUsage,
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:01.000Z"
    });
    const workerResult2 = createRuntimeResult({
      executionId: "exec-w2",
      agentId: "worker-a",
      role: "worker",
      status: "completed",
      output: JSON.stringify(makeTaskResultDoc()),
      usage: workerUsage,
      startedAt: "2026-07-14T00:00:02.000Z",
      endedAt: "2026-07-14T00:00:03.000Z"
    });

    let workerCall = 0;
    const workerRuntimeFactory = () => ({
      execute: async () => {
        workerCall += 1;
        return workerCall === 1 ? workerResult1 : workerResult2;
      }
    });

    const reworkDecision = { taskId: task.taskId, decision: "rework", feedback: [{ code: "X", description: "more" }], nextAttempt: 2, maxAttempts: 3 };
    const approveDecision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 3, maxAttempts: 3 };

    let managerCall = 0;
    const managerRuntimeFactory = () => ({
      execute: async () => {
        managerCall += 1;
        const decision = managerCall === 1 ? reworkDecision : approveDecision;
        return createRuntimeResult({
          executionId: `exec-m${managerCall}`,
          agentId: "manager-codex",
          role: "manager",
          status: "completed",
          output: JSON.stringify(decision),
          usage: { inputTokens: 500, outputTokens: 500, calls: 1 },
          startedAt: "2026-07-14T00:00:01.500Z",
          endedAt: "2026-07-14T00:00:01.900Z"
        });
      }
    });
    const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };

    const result = await runCampaignTask(rootDir, {
      campaign,
      task,
      managerAgent,
      workerRuntimeFactory,
      managerRuntimeFactory
    });

    assert.equal(result.loop.outcome, "approved");
    assert.equal(result.loop.attempts, 2);

    const persistedCampaign = loadCampaign(rootDir, campaign.campaignId);
    const costs = persistedCampaign.usage.estimatedCostByProvider;
    // Codex pricing is intentionally free (see budget.mjs PROVIDER_PRICING),
    // so the estimated codex cost is 0 — the bug this guards against is that
    // manager usage was never fed into estimateCost at all, so the "codex"
    // key never appeared in estimatedCostByProvider.
    assert.ok("codex" in costs, "manager (codex) cost must be estimated");

    // Both worker attempts' usage must be counted, not just the final one.
    const perAttemptCost = (1000 / 1000) * 0.00027 + (1000 / 1000) * 0.0011;
    assert.ok(
      Math.abs(costs.deepseek - perAttemptCost * 2) < 1e-9,
      `expected accumulated cost ~${perAttemptCost * 2}, got ${costs.deepseek}`
    );
  });
});

test("runCampaignTask: campaign.budget.maxAttemptsPerTask clamps task.maxAttempts even when the task/agent allow more — Important 4", async () => {
  await withTempDirAsync(async (rootDir) => {
    saveSkill(rootDir, makeSkillDoc());
    saveAgent(rootDir, makeAgentDoc({ limits: { maxAttemptsPerTask: 5, maxExecutionMinutes: 20, maxToolCalls: 40 } }));

    const campaign = createCampaign(rootDir, {
      brief: "b",
      acceptanceCriteria: ["x"],
      budget: { maxWorkerCalls: 10, maxManagerCalls: 10, maxAttemptsPerTask: 1 }
    });
    campaign.status = "running";
    saveCampaign(rootDir, campaign);

    const task = makeTaskDoc({ campaignId: campaign.campaignId, maxAttempts: 3 });

    const workerResult = createRuntimeResult({
      executionId: "exec-w1",
      agentId: "worker-a",
      role: "worker",
      status: "completed",
      output: JSON.stringify(makeTaskResultDoc()),
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:01.000Z"
    });

    let workerCalls = 0;
    const workerRuntimeFactory = () => ({
      execute: async () => {
        workerCalls += 1;
        return workerResult;
      }
    });

    // The manager always says "rework" — if the cap didn't apply, the loop
    // would keep going up to task.maxAttempts (3).
    const reworkDecision = { taskId: task.taskId, decision: "rework", feedback: [{ code: "X", description: "again" }], nextAttempt: 2, maxAttempts: 3 };
    const managerRuntimeFactory = () => ({
      execute: async () =>
        createRuntimeResult({
          executionId: "exec-m1",
          agentId: "manager-codex",
          role: "manager",
          status: "completed",
          output: JSON.stringify(reworkDecision),
          startedAt: "2026-07-14T00:00:01.000Z",
          endedAt: "2026-07-14T00:00:01.500Z"
        })
    });
    const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };

    const result = await runCampaignTask(rootDir, {
      campaign,
      task,
      managerAgent,
      workerRuntimeFactory,
      managerRuntimeFactory
    });

    assert.equal(workerCalls, 1);
    assert.equal(result.loop.attempts, 1);
    assert.equal(result.loop.outcome, "escalated");
  });
});

// --- CLI smoke tests --------------------------------------------------------

test("orchestration-cli campaign create --json then campaign show --json: exit 0, ids match", () => {
  const rootDir = makeTempDir("campaign-cli-test-");
  try {
    const createResult = run(
      "node",
      [CLI, "campaign", "create", "--brief", "Improve coverage", "--criteria", "tests pass", "--cwd", rootDir, "--json"],
      { cwd: ROOT }
    );
    assert.equal(createResult.status, 0, createResult.stderr);
    const created = JSON.parse(createResult.stdout);
    assert.ok(created.campaignId);

    const showResult = run("node", [CLI, "campaign", "show", created.campaignId, "--cwd", rootDir, "--json"], {
      cwd: ROOT
    });
    assert.equal(showResult.status, 0, showResult.stderr);
    const shown = JSON.parse(showResult.stdout);
    assert.equal(shown.campaign.campaignId, created.campaignId);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("orchestration-cli campaign review-proposals: budget exhaustion pauses the campaign and is reported — Important 5", () => {
  const rootDir = makeTempDir("campaign-cli-test-");
  try {
    const createResult = run(
      "node",
      [
        CLI,
        "campaign",
        "create",
        "--brief",
        "Improve coverage",
        "--criteria",
        "tests pass",
        "--max-manager-calls",
        "0",
        "--cwd",
        rootDir,
        "--json"
      ],
      { cwd: ROOT }
    );
    assert.equal(createResult.status, 0, createResult.stderr);
    const created = JSON.parse(createResult.stdout);

    const approveResult = run(
      "node",
      [CLI, "campaign", "approve", created.campaignId, "--approved-by", "exec-tin", "--cwd", rootDir, "--json"],
      { cwd: ROOT }
    );
    assert.equal(approveResult.status, 0, approveResult.stderr);

    recordProposals(rootDir, {
      campaignId: created.campaignId,
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [
        {
          scope: "project/shared",
          type: "convention",
          content: "Always assert exit codes.",
          evidence: ["evidence"],
          confidence: 0.9
        }
      ]
    });

    const reviewResult = run(
      "node",
      [CLI, "campaign", "review-proposals", created.campaignId, "--decided-by", "exec-tin", "--cwd", rootDir, "--json"],
      { cwd: ROOT }
    );
    assert.equal(reviewResult.status, 0, reviewResult.stderr);
    const reviewed = JSON.parse(reviewResult.stdout);
    assert.equal(reviewed.halted, true);
    assert.equal(reviewed.processed.length, 0);

    const showResult = run("node", [CLI, "campaign", "show", created.campaignId, "--cwd", rootDir, "--json"], {
      cwd: ROOT
    });
    const shown = JSON.parse(showResult.stdout);
    assert.equal(shown.campaign.status, "paused");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("orchestration-cli campaign approve without --approved-by exits 1 and mentions approved-by", () => {
  const rootDir = makeTempDir("campaign-cli-test-");
  try {
    const createResult = run(
      "node",
      [CLI, "campaign", "create", "--brief", "Improve coverage", "--criteria", "tests pass", "--cwd", rootDir, "--json"],
      { cwd: ROOT }
    );
    const created = JSON.parse(createResult.stdout);

    const approveResult = run("node", [CLI, "campaign", "approve", created.campaignId, "--cwd", rootDir], {
      cwd: ROOT
    });
    assert.notEqual(approveResult.status, 0);
    assert.match(approveResult.stderr, /approved-by/i);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
