#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { ensureAbsolutePath, readJsonFile } from "./lib/fs.mjs";
import { loadOrchestrationSchema, validateAgainstSchema } from "./lib/schema-validator.mjs";
import { analyzeRepository, writeProjectProfile } from "./orchestration/repository-analyzer.mjs";
import { proposeTopology, writeTopologyProposal, approveTopology } from "./orchestration/topology-planner.mjs";
import {
  createCampaign,
  loadCampaign,
  saveCampaign,
  listCampaigns,
  setCampaignStatus,
  runCampaignTask
} from "./orchestration/campaign-orchestrator.mjs";
import { appendAuditEvent } from "./orchestration/audit-log.mjs";
import { createBudget } from "./orchestration/budget.mjs";
import { listProposals } from "./memory/proposal-store.mjs";
import { createMemoryReviewer, reviewPendingProposals } from "./memory/memory-review.mjs";
import { loadAgent } from "./agents/agent-registry.mjs";
import { createCodexRuntime } from "./runtimes/codex-runtime.mjs";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/orchestration-cli.mjs bootstrap [--cwd <path>] [--profile-only] [--json]",
      "  node scripts/orchestration-cli.mjs approve-topology --approved-by <role> [--cwd <path>] [--json]",
      "  node scripts/orchestration-cli.mjs campaign create --brief <text> [--criteria <text>]...",
      "      [--max-executive-calls N] [--max-manager-calls N] [--max-worker-calls N]",
      "      [--max-attempts-per-task N] [--max-campaign-duration-minutes N] [--cwd <path>] [--json]",
      "  node scripts/orchestration-cli.mjs campaign list [--cwd <path>] [--json]",
      "  node scripts/orchestration-cli.mjs campaign show <campaignId> [--cwd <path>] [--json]",
      "  node scripts/orchestration-cli.mjs campaign run-task <campaignId> --task-file <path.json>",
      "      [--manager-agent <id>] [--cwd <path>] [--json]",
      "  node scripts/orchestration-cli.mjs campaign approve --approved-by <role> <campaignId> [--cwd <path>] [--json]",
      "  node scripts/orchestration-cli.mjs campaign review-proposals <campaignId> --decided-by <role> [--cwd <path>] [--json]",
      "  node scripts/orchestration-cli.mjs campaign accept <campaignId> --accepted-by <role> [--cwd <path>] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(argv, config);
}

function joinList(items) {
  return items && items.length > 0 ? items.join(", ") : "(none)";
}

function renderProfileOnlyReport(profile) {
  const lines = [
    "Repository profile written to .ai-company/project-profile.json.",
    "",
    `Languages: ${joinList(profile.languages)}`,
    `Frameworks: ${joinList(profile.frameworks)}`,
    `Test command: ${profile.commands?.test ?? "(none)"}`,
    `Top-level dirs: ${joinList(profile.structure?.dirs)}`,
    "",
    "Profile-only run: no topology was proposed. Rerun without --profile-only to propose one."
  ];
  return `${lines.join("\n")}\n`;
}

function renderBootstrapReport(proposal) {
  const lines = [
    `Topology type: ${proposal.topologyType}`,
    proposal.rationale,
    "",
    "Agents:"
  ];

  for (const agent of proposal.agents) {
    lines.push(`- ${agent.id} (${agent.type})`);
    lines.push(`    ownership.primary: ${joinList(agent.ownership?.primary)}`);
    lines.push(`    write: ${joinList(agent.permissions?.write)}`);
    lines.push(`    skills: ${joinList(agent.skills)}`);
  }

  lines.push("", "Skill drafts:");
  for (const draft of proposal.skillDrafts ?? []) {
    lines.push(`- ${draft.id}: ${draft.purpose}`);
  }

  lines.push("", "Overlaps:");
  for (const overlap of proposal.overlaps ?? []) {
    lines.push(`- ${overlap}`);
  }

  lines.push("", "Risks:");
  for (const risk of proposal.risks ?? []) {
    lines.push(`- ${risk}`);
  }

  lines.push(
    "",
    "Nothing has been activated. To register these agents and skills, approve the proposal with:",
    "  /codex:bootstrap-agents --approve --approved-by <role>"
  );

  return `${lines.join("\n")}\n`;
}

function renderApproveReport(result) {
  const lines = ["Registered agents (active):"];
  for (const id of result.agents) {
    lines.push(`- ${id}`);
  }
  lines.push("", "Registered skills (draft):");
  for (const id of result.skills) {
    lines.push(`- ${id}`);
  }
  return `${lines.join("\n")}\n`;
}

async function handleBootstrap(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "profile-only"]
  });

  const cwd = resolveCommandCwd(options);
  const profile = analyzeRepository(cwd);
  writeProjectProfile(cwd, profile);

  if (options["profile-only"]) {
    outputResult(options.json ? { profile } : renderProfileOnlyReport(profile), options.json);
    return;
  }

  const { proposal } = await proposeTopology(cwd, { profile });
  writeTopologyProposal(cwd, proposal);

  outputResult(options.json ? { profile, proposal } : renderBootstrapReport(proposal), options.json);
}

// --- campaign subcommands --------------------------------------------------

function extractRepeatedOption(argv, name) {
  const flag = `--${name}`;
  const prefix = `${flag}=`;
  const values = [];
  const rest = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === flag) {
      values.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith(prefix)) {
      values.push(token.slice(prefix.length));
      continue;
    }
    rest.push(token);
  }

  return { values, rest };
}

function renderCampaignReport(campaign) {
  const lines = [
    `Campaign ${campaign.campaignId} (${campaign.status})`,
    `Brief: ${campaign.brief}`,
    "",
    "Budget:",
    ...Object.entries(campaign.budget).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Usage:",
    ...Object.entries(campaign.usage).map(([key, value]) =>
      key === "estimatedCostByProvider" ? `- ${key}: ${JSON.stringify(value)}` : `- ${key}: ${value}`
    )
  ];
  return `${lines.join("\n")}\n`;
}

async function handleCampaignCreate(argv) {
  const { values: acceptanceCriteria, rest } = extractRepeatedOption(argv, "criteria");
  const { options } = parseCommandInput(rest, {
    valueOptions: [
      "cwd",
      "brief",
      "max-executive-calls",
      "max-manager-calls",
      "max-worker-calls",
      "max-attempts-per-task",
      "max-campaign-duration-minutes"
    ],
    booleanOptions: ["json"]
  });

  if (!options.brief) {
    throw new Error("Missing required --brief <text>.");
  }
  if (acceptanceCriteria.length === 0) {
    throw new Error("Missing required --criteria <text> (at least one).");
  }

  const cwd = resolveCommandCwd(options);
  const budget = {};
  const numericFlagToBudgetKey = {
    "max-executive-calls": "maxExecutiveCalls",
    "max-manager-calls": "maxManagerCalls",
    "max-worker-calls": "maxWorkerCalls",
    "max-attempts-per-task": "maxAttemptsPerTask",
    "max-campaign-duration-minutes": "maxCampaignDurationMinutes"
  };
  for (const [flag, budgetKey] of Object.entries(numericFlagToBudgetKey)) {
    if (options[flag] !== undefined) {
      budget[budgetKey] = Number(options[flag]);
    }
  }

  const campaign = createCampaign(cwd, { brief: options.brief, acceptanceCriteria, budget });

  outputResult(options.json ? campaign : renderCampaignReport(campaign), options.json);
}

async function handleCampaignList(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const campaigns = listCampaigns(cwd);

  if (options.json) {
    outputResult({ campaigns }, true);
    return;
  }

  if (campaigns.length === 0) {
    outputResult("(no campaigns)\n", false);
    return;
  }
  const lines = campaigns.map((campaign) => `- ${campaign.campaignId} (${campaign.status}): ${campaign.brief}`);
  outputResult(`${lines.join("\n")}\n`, false);
}

function requireCampaign(cwd, campaignId) {
  const campaign = loadCampaign(cwd, campaignId);
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }
  return campaign;
}

async function handleCampaignShow(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const campaignId = positionals[0];
  if (!campaignId) {
    throw new Error("Missing required <campaignId>.");
  }

  const cwd = resolveCommandCwd(options);
  const campaign = requireCampaign(cwd, campaignId);

  const tasksDir = path.join(cwd, ".ai-company", "campaigns", campaignId, "tasks");
  const tasks = fs.existsSync(tasksDir)
    ? fs
        .readdirSync(tasksDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const doc = readJsonFile(path.join(tasksDir, name));
          return { taskId: doc.taskId, status: doc.status };
        })
    : [];

  const pendingProposals = listProposals(cwd, { status: "pending" }).filter(
    (proposal) => proposal.campaignId === campaignId
  ).length;

  const payload = { campaign, tasks, pendingProposals };

  if (options.json) {
    outputResult(payload, true);
    return;
  }

  const lines = [
    renderCampaignReport(campaign).trimEnd(),
    "",
    `Tasks (${tasks.length}):`,
    ...tasks.map((task) => `- ${task.taskId}: ${task.status}`),
    "",
    `Pending memory proposals: ${pendingProposals}`
  ];
  outputResult(`${lines.join("\n")}\n`, false);
}

async function handleCampaignRunTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "task-file", "manager-agent"],
    booleanOptions: ["json"]
  });
  const campaignId = positionals[0];
  if (!campaignId) {
    throw new Error("Missing required <campaignId>.");
  }
  if (!options["task-file"]) {
    throw new Error("Missing required --task-file <path.json>.");
  }

  const cwd = resolveCommandCwd(options);
  const campaign = requireCampaign(cwd, campaignId);

  const taskPath = ensureAbsolutePath(cwd, options["task-file"]);
  const task = readJsonFile(taskPath);
  const taskSchema = loadOrchestrationSchema("task");
  const { valid, errors } = validateAgainstSchema(task, taskSchema);
  if (!valid) {
    throw new Error(`Invalid task document:\n${errors.join("\n")}`);
  }

  const managerAgentId = options["manager-agent"] ?? "manager-codex";
  const managerAgent = loadAgent(cwd, managerAgentId) ?? {
    id: managerAgentId,
    name: managerAgentId,
    runtime: { provider: "codex", model: null }
  };

  const result = await runCampaignTask(cwd, { campaign, task, managerAgent });

  if (options.json) {
    outputResult(result, true);
    return;
  }

  const lines = [
    `Outcome: ${result.loop.outcome}`,
    `Attempts: ${result.loop.attempts}`,
    `Owner: ${result.routing.owner.id}`,
    `Memory proposals stored: ${result.proposals.stored.length}, rejected: ${result.proposals.rejected.length}`
  ];
  if (result.loop.outcome === "halted") {
    lines.push(`Halt reason: ${result.loop.reason ?? "(unknown)"}`);
    lines.push("The campaign has been paused on budget exhaustion.");
  }
  if (result.loop.outcome === "escalated" || result.loop.outcome === "escalate") {
    lines.push(`Escalation feedback: ${JSON.stringify(result.loop.decision?.feedback ?? [])}`);
  }
  outputResult(`${lines.join("\n")}\n`, false);
}

async function handleCampaignApprove(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "approved-by"],
    booleanOptions: ["json"]
  });
  const campaignId = positionals[0];
  if (!campaignId) {
    throw new Error("Missing required <campaignId>.");
  }
  if (!options["approved-by"]) {
    throw new Error("Missing required --approved-by <role>. Approving a campaign requires a named approver.");
  }

  const cwd = resolveCommandCwd(options);
  const campaign = requireCampaign(cwd, campaignId);

  if (campaign.status === "draft") {
    setCampaignStatus(cwd, campaignId, "awaiting_approval");
  }

  const approval = { role: options["approved-by"], decision: "approve", at: new Date().toISOString() };
  const updated = setCampaignStatus(cwd, campaignId, "running", approval);

  outputResult(options.json ? updated : renderCampaignReport(updated), options.json);
}

async function handleCampaignReviewProposals(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "decided-by"],
    booleanOptions: ["json"]
  });
  const campaignId = positionals[0];
  if (!campaignId) {
    throw new Error("Missing required <campaignId>.");
  }
  if (!options["decided-by"]) {
    throw new Error("Missing required --decided-by <role>. Deciding memory proposals requires a named decider.");
  }

  const cwd = resolveCommandCwd(options);
  const campaign = requireCampaign(cwd, campaignId);

  const managerAgent = { id: "manager-codex", name: "Manager", runtime: { provider: "codex", model: null } };
  const managerRuntime = createCodexRuntime({ rootDir: cwd });
  const decide = createMemoryReviewer({ rootDir: cwd, runtime: managerRuntime, managerAgent });

  const budget = createBudget(campaign);
  const guards = { beforeManagerCall: () => budget.guards.beforeManagerCall() };

  const result = await reviewPendingProposals(cwd, {
    campaignId,
    decide,
    decidedBy: options["decided-by"],
    guards
  });

  // `budget` mutated `campaign.usage` in place as guards ran; persist it.
  saveCampaign(cwd, campaign);

  if (result.halted) {
    // Consistent with runCampaignTask: budget exhaustion pauses the
    // campaign rather than leaving it "running" with no code-level signal.
    try {
      setCampaignStatus(cwd, campaignId, "paused");
    } catch {
      // Not in a state (e.g. already paused, or not "running") from which
      // "paused" is a legal transition. Never let that crash this command —
      // the campaign_paused_budget audit event below still records why.
    }
    appendAuditEvent(cwd, campaignId, {
      event: "campaign_paused_budget",
      reason: "review-proposals budget exhausted"
    });
  }

  if (options.json) {
    outputResult(result, true);
    return;
  }

  const lines = [
    `Processed ${result.processed.length} proposal(s)${result.halted ? " (halted on budget exhaustion)" : ""}:`,
    ...result.processed.map((item) =>
      item.action === "failed" ? `- ${item.proposalId}: failed (${item.error})` : `- ${item.proposalId}: ${item.action}`
    )
  ];
  if (result.halted) {
    lines.push("The campaign has been paused on budget exhaustion.");
  }
  outputResult(`${lines.join("\n")}\n`, false);
}

async function handleCampaignAccept(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "accepted-by"],
    booleanOptions: ["json"]
  });
  const campaignId = positionals[0];
  if (!campaignId) {
    throw new Error("Missing required <campaignId>.");
  }
  if (!options["accepted-by"]) {
    throw new Error("Missing required --accepted-by <role>. Accepting a campaign requires a named acceptor.");
  }

  const cwd = resolveCommandCwd(options);
  const updated = setCampaignStatus(cwd, campaignId, "completed");
  appendAuditEvent(cwd, campaignId, { event: "campaign_accepted", acceptedBy: options["accepted-by"] });

  outputResult(options.json ? updated : renderCampaignReport(updated), options.json);
}

async function handleCampaign(argv) {
  const [action, ...rest] = argv;
  switch (action) {
    case "create":
      await handleCampaignCreate(rest);
      break;
    case "list":
      await handleCampaignList(rest);
      break;
    case "show":
      await handleCampaignShow(rest);
      break;
    case "run-task":
      await handleCampaignRunTask(rest);
      break;
    case "approve":
      await handleCampaignApprove(rest);
      break;
    case "review-proposals":
      await handleCampaignReviewProposals(rest);
      break;
    case "accept":
      await handleCampaignAccept(rest);
      break;
    default:
      throw new Error(`Unknown campaign action: ${action}`);
  }
}

async function handleApproveTopology(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "approved-by"],
    booleanOptions: ["json"]
  });

  if (!options["approved-by"]) {
    throw new Error("Missing required --approved-by <role>. Approving a topology requires a named approver.");
  }

  const cwd = resolveCommandCwd(options);
  const result = approveTopology(cwd, { approvedBy: options["approved-by"] });

  outputResult(options.json ? result : renderApproveReport(result), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "bootstrap":
      await handleBootstrap(argv);
      break;
    case "approve-topology":
      await handleApproveTopology(argv);
      break;
    case "campaign":
      await handleCampaign(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
