import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeRepository } from "./repository-analyzer.mjs";
import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { writeJsonFile } from "../lib/fs.mjs";
import { runAppServerTurn, parseStructuredOutput } from "../lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";
import { saveAgent, setAgentStatus } from "../agents/agent-registry.mjs";
import { saveSkill } from "../skills/skill-registry.mjs";

/**
 * Codex-backed topology planner: turns a project profile into a proposed
 * agent topology (draft agents + draft skills), then, on explicit approval,
 * registers the real agent/skill documents. Nothing is ever activated
 * without an approval record.
 */

const PLUGIN_ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_SKILL_VERSION = "0.1.0";
const DEFAULT_AGENT_RUNTIME = { provider: "deepseek", model: "deepseek-chat" };

function buildPrompt(profile) {
  const template = loadPromptTemplate(PLUGIN_ROOT_DIR, "orchestration/topology-proposal");
  return interpolateTemplate(template, {
    PROJECT_PROFILE: JSON.stringify(profile, null, 2)
  });
}

function buildCorrectionPrompt(prompt, errors) {
  const errorList = errors.map((error) => `- ${error}`).join("\n");
  return `${prompt}\n\n## Correction required\nThe previous response failed validation with these errors:\n${errorList}\n\nReturn ONLY corrected JSON matching the schema.`;
}

function tryParseAndValidate(finalMessage, schema) {
  const { parsed, parseError } = parseStructuredOutput(finalMessage);
  if (!parsed) {
    return { ok: false, errors: [parseError ?? "Codex did not return a parseable JSON message."] };
  }

  const { valid, errors } = validateAgainstSchema(parsed, schema);
  if (!valid) {
    return { ok: false, errors };
  }

  return { ok: true, value: parsed };
}

export async function proposeTopology(rootDir, { profile, runTurn = runAppServerTurn, onProgress } = {}) {
  const resolvedProfile = profile ?? analyzeRepository(rootDir);
  const schema = loadOrchestrationSchema("topology-proposal");
  const prompt = buildPrompt(resolvedProfile);

  const firstAttempt = await runTurn(rootDir, {
    prompt,
    sandbox: "read-only",
    outputSchema: schema,
    onProgress
  });

  const firstResult = tryParseAndValidate(firstAttempt.finalMessage, schema);
  if (firstResult.ok) {
    return { proposal: firstResult.value, threadId: firstAttempt.threadId };
  }

  const retryPrompt = buildCorrectionPrompt(prompt, firstResult.errors);
  const secondAttempt = await runTurn(rootDir, {
    prompt: retryPrompt,
    sandbox: "read-only",
    outputSchema: schema,
    onProgress
  });

  const secondResult = tryParseAndValidate(secondAttempt.finalMessage, schema);
  if (secondResult.ok) {
    return { proposal: secondResult.value, threadId: secondAttempt.threadId };
  }

  throw new Error(
    `Topology proposal failed validation after one retry:\n${secondResult.errors.join("\n")}`
  );
}

export function writeTopologyProposal(rootDir, proposal) {
  const schema = loadOrchestrationSchema("topology-proposal");
  const { valid, errors } = validateAgainstSchema(proposal, schema);
  if (!valid) {
    throw new Error(`Invalid topology proposal:\n${errors.join("\n")}`);
  }

  const outputDir = path.join(rootDir, ".ai-company");
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "topology-proposal.json");
  writeJsonFile(filePath, proposal);
  return filePath;
}

function readTopologyProposal(rootDir) {
  const filePath = path.join(rootDir, ".ai-company", "topology-proposal.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Topology proposal not found: ${filePath}. Run bootstrap first (\`orchestration-cli.mjs bootstrap\`).`
    );
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveAgentSkillRef(ref, draftIds) {
  if (draftIds.has(ref)) {
    return `${ref}@${DEFAULT_SKILL_VERSION}`;
  }
  return ref.includes("@") ? ref : `${ref}@${DEFAULT_SKILL_VERSION}`;
}

function buildSkillDocument(skillDraft) {
  const procedure =
    Array.isArray(skillDraft.procedure) && skillDraft.procedure.length > 0
      ? skillDraft.procedure
      : ["(to be evaluated)"];

  return {
    id: skillDraft.id,
    version: DEFAULT_SKILL_VERSION,
    status: "draft",
    purpose: skillDraft.purpose,
    useWhen: skillDraft.useWhen ?? [],
    dontUseWhen: [],
    requiredInputs: [],
    procedure,
    verificationSteps: [],
    doneWhen: [],
    escalateWhen: [],
    outputContract: "task-result",
    sources: skillDraft.sources,
    owner: "manager-codex"
  };
}

function buildAgentDocument(proposedAgent, draftIds) {
  return {
    id: proposedAgent.id,
    name: proposedAgent.name,
    type: proposedAgent.type === "persistent" ? "persistent" : "temporary",
    status: "proposed",
    ownership: proposedAgent.ownership,
    responsibilities: proposedAgent.responsibilities,
    skills: proposedAgent.skills.map((ref) => resolveAgentSkillRef(ref, draftIds)),
    memory: { namespaces: [`agent/${proposedAgent.id}`, "project/shared"] },
    permissions: proposedAgent.permissions,
    runtime: DEFAULT_AGENT_RUNTIME,
    limits: { maxAttemptsPerTask: 3, maxExecutionMinutes: 20, maxToolCalls: 40 }
  };
}

export function approveTopology(rootDir, { approvedBy, decidedAt = new Date().toISOString() } = {}) {
  if (!approvedBy) {
    throw new Error("approvedBy is required to approve a topology proposal.");
  }

  const proposal = readTopologyProposal(rootDir);
  const skillDrafts = proposal.skillDrafts ?? [];
  const draftIds = new Set(skillDrafts.map((draft) => draft.id));

  const skillIds = [];
  for (const skillDraft of skillDrafts) {
    const skill = buildSkillDocument(skillDraft);
    saveSkill(rootDir, skill);
    skillIds.push(skill.id);
  }

  const agentIds = [];
  for (const proposedAgent of proposal.agents) {
    const agent = buildAgentDocument(proposedAgent, draftIds);
    saveAgent(rootDir, agent);
    setAgentStatus(rootDir, agent.id, "active", {
      role: approvedBy,
      decision: "approve",
      at: decidedAt
    });
    agentIds.push(agent.id);
  }

  return { agents: agentIds, skills: skillIds };
}
