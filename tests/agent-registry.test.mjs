import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  saveAgent,
  loadAgent,
  listAgents,
  setAgentStatus,
  findAgentsBySkill
} from "../plugins/codex/scripts/agents/agent-registry.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
}

function withTempDir(fn) {
  const rootDir = makeTempDir();
  try {
    fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function makeAgent(overrides = {}) {
  return {
    id: "test-worker-01",
    name: "Test Worker",
    type: "persistent",
    status: "proposed",
    ownership: { primary: ["tests/**"], secondary: [], excluded: [] },
    responsibilities: ["write and maintain tests"],
    skills: ["technical/node-test-authoring@1.0.0"],
    memory: { namespaces: ["test-worker"] },
    permissions: { read: ["**"], write: ["tests/**"] },
    runtime: { provider: "codex", model: "gpt-5" },
    limits: { maxAttemptsPerTask: 3, maxExecutionMinutes: 30, maxToolCalls: 50 },
    ...overrides
  };
}

test("saveAgent + loadAgent round-trip", () => {
  withTempDir((rootDir) => {
    const agent = makeAgent();
    const filePath = saveAgent(rootDir, agent);

    assert.equal(filePath, path.join(rootDir, ".ai-company", "agents", "test-worker-01.json"));
    assert.ok(fs.existsSync(filePath));
    const raw = fs.readFileSync(filePath, "utf8");
    assert.ok(raw.endsWith("\n"));

    const loaded = loadAgent(rootDir, "test-worker-01");
    assert.deepEqual(loaded, agent);
  });
});

test("loadAgent returns null for a missing agent", () => {
  withTempDir((rootDir) => {
    assert.equal(loadAgent(rootDir, "nope"), null);
  });
});

test("saveAgent throws with schema errors listed for an invalid agent", () => {
  withTempDir((rootDir) => {
    const agent = makeAgent({ id: "" });
    delete agent.limits;

    assert.throws(() => saveAgent(rootDir, agent), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /limits/);
      return true;
    });
  });
});

test("listAgents returns [] when the agents dir is missing", () => {
  withTempDir((rootDir) => {
    assert.deepEqual(listAgents(rootDir), []);
  });
});

test("listAgents sorts by id and tolerates a corrupt JSON file", () => {
  withTempDir((rootDir) => {
    saveAgent(rootDir, makeAgent({ id: "zeta-agent" }));
    saveAgent(rootDir, makeAgent({ id: "alpha-agent" }));

    const agentsDir = path.join(rootDir, ".ai-company", "agents");
    fs.writeFileSync(path.join(agentsDir, "corrupt.json"), "{ not valid json");

    const agents = listAgents(rootDir);
    assert.deepEqual(agents.map((a) => a.id), ["alpha-agent", "zeta-agent"]);
  });
});

test("setAgentStatus allows proposed -> active with a required approval", () => {
  withTempDir((rootDir) => {
    saveAgent(rootDir, makeAgent());
    const approval = { role: "executive", decision: "approve", at: "2026-07-13T00:00:00.000Z" };

    setAgentStatus(rootDir, "test-worker-01", "active", approval);

    const loaded = loadAgent(rootDir, "test-worker-01");
    assert.equal(loaded.status, "active");
    assert.deepEqual(loaded.approvals, [approval]);
  });
});

test("setAgentStatus throws when approval is missing for proposed -> active", () => {
  withTempDir((rootDir) => {
    saveAgent(rootDir, makeAgent());

    assert.throws(() => setAgentStatus(rootDir, "test-worker-01", "active"), /approval/i);

    const loaded = loadAgent(rootDir, "test-worker-01");
    assert.equal(loaded.status, "proposed");
  });
});

test("setAgentStatus allows active -> retired without approval", () => {
  withTempDir((rootDir) => {
    saveAgent(rootDir, makeAgent({ status: "active" }));

    setAgentStatus(rootDir, "test-worker-01", "retired");

    const loaded = loadAgent(rootDir, "test-worker-01");
    assert.equal(loaded.status, "retired");
  });
});

test("setAgentStatus throws on illegal transitions", () => {
  withTempDir((rootDir) => {
    saveAgent(rootDir, makeAgent({ status: "proposed" }));

    assert.throws(
      () => setAgentStatus(rootDir, "test-worker-01", "retired"),
      /Illegal agent status transition: proposed -> retired/
    );
  });
});

test("setAgentStatus throws on retired -> active (terminal state)", () => {
  withTempDir((rootDir) => {
    saveAgent(rootDir, makeAgent({ status: "retired" }));

    assert.throws(
      () => setAgentStatus(rootDir, "test-worker-01", "active", { role: "x", decision: "approve", at: "now" }),
      /Illegal agent status transition: retired -> active/
    );
  });
});

test("findAgentsBySkill matches the exact skill ref only", () => {
  withTempDir((rootDir) => {
    saveAgent(rootDir, makeAgent({ id: "worker-a", skills: ["technical/node-test-authoring@1.0.0"] }));
    saveAgent(rootDir, makeAgent({ id: "worker-b", skills: ["technical/node-test-authoring@2.0.0"] }));
    saveAgent(rootDir, makeAgent({ id: "worker-c", skills: [] }));

    const matches = findAgentsBySkill(rootDir, "technical/node-test-authoring@1.0.0");

    assert.deepEqual(matches.map((a) => a.id), ["worker-a"]);
  });
});
