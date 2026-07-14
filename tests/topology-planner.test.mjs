import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  proposeTopology,
  writeTopologyProposal,
  approveTopology
} from "../plugins/codex/scripts/orchestration/topology-planner.mjs";
import { analyzeRepository } from "../plugins/codex/scripts/orchestration/repository-analyzer.mjs";
import { loadOrchestrationSchema } from "../plugins/codex/scripts/lib/schema-validator.mjs";
import { loadAgent } from "../plugins/codex/scripts/agents/agent-registry.mjs";
import { loadSkill } from "../plugins/codex/scripts/skills/skill-registry.mjs";
import { resolveProvider } from "../plugins/codex/scripts/runtimes/provider-presets.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "plugins", "codex", "scripts", "orchestration-cli.mjs");

async function withTempDir(fn) {
  const rootDir = makeTempDir("topology-planner-test-");
  try {
    await fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function makeValidProposal(overrides = {}) {
  return {
    topologyType: "workflow-oriented",
    rationale: "Small repo with one cohesive area of ownership; extend it as a single persistent worker.",
    agents: [
      {
        id: "test-worker-01",
        name: "Test Worker",
        type: "persistent",
        responsibilities: ["extend test coverage for new orchestration modules"],
        ownership: { primary: ["tests/**"], secondary: ["plugins/codex/scripts/**"], excluded: [] },
        permissions: { read: ["**"], write: ["tests/**"] },
        skills: ["technical/node-test-authoring"],
        rationale: "Owns the test suite and can verify its own work with npm test."
      }
    ],
    skillDrafts: [
      {
        id: "technical/node-test-authoring",
        purpose: "Author node:test suites following this repo's fixture-over-mock conventions.",
        sources: ["tests/state.test.mjs"]
      }
    ],
    overlaps: [],
    risks: [],
    ...overrides
  };
}

function makeInvalidProposal() {
  const { rationale, ...rest } = makeValidProposal();
  return rest;
}

function makeTwoAgentProposal() {
  return {
    topologyType: "workflow-oriented",
    rationale: "One persistent test worker and one temporary docs worker; both need repo doc conventions.",
    agents: [
      {
        id: "test-worker-01",
        name: "Test Worker",
        type: "persistent",
        responsibilities: ["extend test coverage"],
        ownership: { primary: ["tests/**"], secondary: [], excluded: [] },
        permissions: { read: ["**"], write: ["tests/**"] },
        skills: ["project/repo-doc-conventions"],
        rationale: "Owns the test suite."
      },
      {
        id: "docs-worker",
        name: "Docs Worker",
        type: "temporary-template",
        responsibilities: ["update docs to match code changes"],
        ownership: { primary: ["docs/**"], secondary: [], excluded: [] },
        permissions: { read: ["**"], write: ["docs/**"] },
        skills: ["project/repo-doc-conventions"],
        rationale: "Instantiated on demand for doc-only tasks."
      }
    ],
    skillDrafts: [
      {
        id: "project/repo-doc-conventions",
        purpose: "Follow this repo's documentation conventions.",
        sources: ["docs/TARGET_ARCHITECTURE.md"]
      }
    ],
    overlaps: ["Both agents may touch README-adjacent docs; docs-worker defers to test-worker-01 for tests/**."],
    risks: ["docs-worker could drift out of sync if not instantiated regularly."]
  };
}

// 1. Happy path.
test("proposeTopology: happy path returns the proposal and passes the schema as outputSchema", async () => {
  await withTempDir(async (rootDir) => {
    const profile = analyzeRepository(rootDir);
    const calls = [];
    const stub = async (cwd, options) => {
      calls.push({ cwd, options });
      return { status: 0, finalMessage: JSON.stringify(makeValidProposal()), threadId: "t1" };
    };

    const result = await proposeTopology(rootDir, { profile, runTurn: stub });

    assert.deepEqual(result.proposal, makeValidProposal());
    assert.equal(result.threadId, "t1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, rootDir);
    assert.ok(calls[0].options.prompt.includes(JSON.stringify(profile, null, 2)));
    assert.equal(calls[0].options.sandbox, "read-only");
    assert.deepEqual(calls[0].options.outputSchema, loadOrchestrationSchema("topology-proposal"));
  });
});

// 2. Retry path.
test("proposeTopology: retries once on a schema-invalid proposal then succeeds", async () => {
  await withTempDir(async (rootDir) => {
    const profile = analyzeRepository(rootDir);
    const calls = [];
    const stub = async (cwd, options) => {
      calls.push(options);
      if (calls.length === 1) {
        return { status: 0, finalMessage: JSON.stringify(makeInvalidProposal()), threadId: "t1" };
      }
      return { status: 0, finalMessage: JSON.stringify(makeValidProposal()), threadId: "t2" };
    };

    const result = await proposeTopology(rootDir, { profile, runTurn: stub });

    assert.deepEqual(result.proposal, makeValidProposal());
    assert.equal(result.threadId, "t2");
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /Return ONLY corrected JSON/);
    assert.ok(calls[1].prompt.includes('missing required property "rationale"'));
  });
});

// 3. Failure on both attempts.
test("proposeTopology: throws with the validation errors when both attempts are invalid", async () => {
  await withTempDir(async (rootDir) => {
    const profile = analyzeRepository(rootDir);
    const stub = async () => ({
      status: 0,
      finalMessage: JSON.stringify(makeInvalidProposal()),
      threadId: "t1"
    });

    await assert.rejects(
      () => proposeTopology(rootDir, { profile, runTurn: stub }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /missing required property "rationale"/);
        return true;
      }
    );
  });
});

// 4. writeTopologyProposal + approveTopology end-to-end.
test("writeTopologyProposal + approveTopology: registers agents active and skills draft", async () => {
  await withTempDir(async (rootDir) => {
    const proposal = makeTwoAgentProposal();
    const filePath = writeTopologyProposal(rootDir, proposal);

    assert.equal(filePath, path.join(rootDir, ".ai-company", "topology-proposal.json"));
    const raw = fs.readFileSync(filePath, "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.deepEqual(JSON.parse(raw), proposal);

    const result = approveTopology(rootDir, {
      approvedBy: "exec-tin",
      decidedAt: "2026-07-13T00:00:00.000Z"
    });

    assert.deepEqual([...result.agents].sort(), ["docs-worker", "test-worker-01"]);
    assert.deepEqual(result.skills, ["project/repo-doc-conventions"]);

    const persistentAgent = loadAgent(rootDir, "test-worker-01");
    assert.equal(persistentAgent.status, "active");
    assert.equal(persistentAgent.type, "persistent");
    assert.deepEqual(persistentAgent.approvals, [
      { role: "exec-tin", decision: "approve", at: "2026-07-13T00:00:00.000Z" }
    ]);
    assert.deepEqual(persistentAgent.skills, ["project/repo-doc-conventions@0.1.0"]);
    assert.deepEqual(persistentAgent.memory, { namespaces: ["agent/test-worker-01", "project/shared"] });
    assert.deepEqual(persistentAgent.runtime, { provider: "deepseek", model: "deepseek-chat" });

    // Verify the runtime pairing is coherent: resolveProvider should work without throwing
    // and should yield a non-null baseUrl when DEEPSEEK_API_KEY is set.
    const resolved = resolveProvider(persistentAgent.runtime.provider, {
      env: { DEEPSEEK_API_KEY: "test-key" }
    });
    assert.equal(resolved.id, "deepseek");
    assert.notEqual(resolved.baseUrl, null);
    assert.equal(resolved.model, "deepseek-chat");

    assert.deepEqual(persistentAgent.limits, {
      maxAttemptsPerTask: 3,
      maxExecutionMinutes: 20,
      maxToolCalls: 40
    });

    const temporaryAgent = loadAgent(rootDir, "docs-worker");
    assert.equal(temporaryAgent.status, "active");
    assert.equal(temporaryAgent.type, "temporary");
    assert.deepEqual(temporaryAgent.skills, ["project/repo-doc-conventions@0.1.0"]);

    const skillPath = path.join(rootDir, ".ai-company", "skills", "project", "repo-doc-conventions.json");
    assert.ok(fs.existsSync(skillPath));
    const skill = loadSkill(rootDir, "project/repo-doc-conventions");
    assert.equal(skill.status, "draft");
    assert.equal(skill.version, "0.1.0");
    assert.equal(skill.owner, "manager-codex");
    assert.deepEqual(skill.procedure, ["(to be evaluated)"]);
    assert.deepEqual(skill.useWhen, []);
    assert.deepEqual(skill.sources, ["docs/TARGET_ARCHITECTURE.md"]);
  });
});

test("approveTopology: throws when approvedBy is missing", async () => {
  await withTempDir(async (rootDir) => {
    writeTopologyProposal(rootDir, makeTwoAgentProposal());

    assert.throws(() => approveTopology(rootDir, {}), /approvedBy/i);
    assert.throws(() => approveTopology(rootDir), /approvedBy/i);
  });
});

test("approveTopology: throws a clear error when the proposal file is missing", async () => {
  await withTempDir(async (rootDir) => {
    assert.throws(
      () => approveTopology(rootDir, { approvedBy: "exec-tin" }),
      /topology-proposal\.json/
    );
  });
});

// 5. CLI smoke tests.
test("orchestration-cli bootstrap --profile-only writes the project profile and exits 0", () => {
  const rootDir = makeTempDir("topology-planner-cli-");
  try {
    const result = run("node", [CLI, "bootstrap", "--profile-only", "--cwd", rootDir, "--json"], {
      cwd: ROOT
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.profile);
    assert.equal(payload.proposal, undefined);

    const profilePath = path.join(rootDir, ".ai-company", "project-profile.json");
    assert.ok(fs.existsSync(profilePath));
    assert.deepEqual(JSON.parse(fs.readFileSync(profilePath, "utf8")), payload.profile);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("orchestration-cli approve-topology without --approved-by exits 1 and mentions approved-by", () => {
  const rootDir = makeTempDir("topology-planner-cli-");
  try {
    const result = run("node", [CLI, "approve-topology", "--cwd", rootDir], { cwd: ROOT });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approved-by/i);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
