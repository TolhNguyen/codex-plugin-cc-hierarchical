import fs from "node:fs";
import path from "node:path";

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { writeJsonFile } from "../lib/fs.mjs";

/**
 * File-backed skill registry: one skill document per file under
 * `<rootDir>/.ai-company/skills/<tier>/<name>.json`, where the skill `id` is
 * always `<tier>/<name>`.
 */

const SKILLS_DIRNAME = "skills";

const SKILL_STATUS_TRANSITIONS = {
  draft: ["evaluating"],
  evaluating: ["approved"],
  approved: ["active"],
  active: ["deprecated"]
};

const APPROVAL_REQUIRED_TRANSITIONS = new Set(["evaluating->approved", "approved->active"]);

function skillsDir(rootDir) {
  return path.join(rootDir, ".ai-company", SKILLS_DIRNAME);
}

function parseSkillId(skillId) {
  const parts = skillId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid skill id: ${skillId}`);
  }
  return { tier: parts[0], name: parts[1] };
}

function skillFilePath(rootDir, skillId) {
  const { tier, name } = parseSkillId(skillId);
  return path.join(skillsDir(rootDir), tier, `${name}.json`);
}

export function saveSkill(rootDir, skill) {
  const schema = loadOrchestrationSchema("skill");
  const { valid, errors } = validateAgainstSchema(skill, schema);
  if (!valid) {
    throw new Error(`Invalid skill:\n${errors.join("\n")}`);
  }

  const filePath = skillFilePath(rootDir, skill.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonFile(filePath, skill);
  return filePath;
}

export function loadSkill(rootDir, skillId) {
  let filePath;
  try {
    filePath = skillFilePath(rootDir, skillId);
  } catch {
    return null;
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadSkillByRef(rootDir, ref) {
  const atIndex = ref.lastIndexOf("@");
  if (atIndex === -1) {
    return null;
  }
  const id = ref.slice(0, atIndex);
  const version = ref.slice(atIndex + 1);

  const skill = loadSkill(rootDir, id);
  if (!skill || skill.id !== id || skill.version !== version) {
    return null;
  }
  return skill;
}

export function listSkills(rootDir, { status } = {}) {
  const dir = skillsDir(rootDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const skills = [];
  for (const tierEntry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!tierEntry.isDirectory()) {
      continue;
    }
    const tierDir = path.join(dir, tierEntry.name);
    for (const fileName of fs.readdirSync(tierDir)) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      try {
        skills.push(JSON.parse(fs.readFileSync(path.join(tierDir, fileName), "utf8")));
      } catch {
        // Skip files that fail to parse instead of throwing.
      }
    }
  }

  const filtered = status ? skills.filter((skill) => skill.status === status) : skills;
  return filtered.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function setSkillStatus(rootDir, skillId, status, { approvedBy } = {}) {
  const skill = loadSkill(rootDir, skillId);
  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  const from = skill.status;
  const allowed = SKILL_STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(status)) {
    throw new Error(`Illegal skill status transition: ${from} -> ${status}`);
  }

  const transitionKey = `${from}->${status}`;
  if (APPROVAL_REQUIRED_TRANSITIONS.has(transitionKey)) {
    if (!approvedBy) {
      throw new Error(`approvedBy is required for skill status transition: ${transitionKey}`);
    }
    skill.approvedBy = approvedBy;
  }

  skill.status = status;
  return saveSkill(rootDir, skill);
}

export function assertSkillsActive(rootDir, refs) {
  const problems = [];
  const skills = [];

  for (const ref of refs) {
    const skill = loadSkillByRef(rootDir, ref);
    if (!skill) {
      problems.push(`${ref} (missing)`);
      continue;
    }
    if (skill.status !== "active") {
      problems.push(`${ref} (status: ${skill.status})`);
      continue;
    }
    skills.push(skill);
  }

  if (problems.length > 0) {
    throw new Error(`Skills not active: ${problems.join(", ")}`);
  }

  return skills;
}

export function recordEvaluation(rootDir, skillId, evaluation) {
  const skill = loadSkill(rootDir, skillId);
  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  skill.evaluations = [...(skill.evaluations ?? []), evaluation];
  return saveSkill(rootDir, skill);
}
