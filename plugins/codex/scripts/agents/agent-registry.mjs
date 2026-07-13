import fs from "node:fs";
import path from "node:path";

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { writeJsonFile } from "../lib/fs.mjs";

/**
 * File-backed agent registry: one agent document per file under
 * `<rootDir>/.ai-company/agents/<agent-id>.json`.
 */

const AGENTS_DIRNAME = "agents";

const AGENT_STATUS_TRANSITIONS = {
  proposed: ["active"],
  active: ["retired"]
};

function agentsDir(rootDir) {
  return path.join(rootDir, ".ai-company", AGENTS_DIRNAME);
}

function agentFilePath(rootDir, agentId) {
  return path.join(agentsDir(rootDir), `${agentId}.json`);
}

export function saveAgent(rootDir, agent) {
  const schema = loadOrchestrationSchema("agent");
  const { valid, errors } = validateAgainstSchema(agent, schema);
  if (!valid) {
    throw new Error(`Invalid agent:\n${errors.join("\n")}`);
  }

  fs.mkdirSync(agentsDir(rootDir), { recursive: true });
  const filePath = agentFilePath(rootDir, agent.id);
  writeJsonFile(filePath, agent);
  return filePath;
}

export function loadAgent(rootDir, agentId) {
  const filePath = agentFilePath(rootDir, agentId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function listAgents(rootDir) {
  const dir = agentsDir(rootDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const agents = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      agents.push(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
    } catch {
      // Skip files that fail to parse instead of throwing.
    }
  }

  return agents.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function setAgentStatus(rootDir, agentId, status, approval) {
  const agent = loadAgent(rootDir, agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const from = agent.status;
  const allowed = AGENT_STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(status)) {
    throw new Error(`Illegal agent status transition: ${from} -> ${status}`);
  }

  if (from === "proposed" && status === "active" && !approval) {
    throw new Error(`Approval is required for agent status transition: ${from} -> ${status}`);
  }

  agent.status = status;
  if (approval) {
    agent.approvals = [...(agent.approvals ?? []), approval];
  }

  return saveAgent(rootDir, agent);
}

export function findAgentsBySkill(rootDir, skillRef) {
  return listAgents(rootDir).filter(
    (agent) => Array.isArray(agent.skills) && agent.skills.includes(skillRef)
  );
}
