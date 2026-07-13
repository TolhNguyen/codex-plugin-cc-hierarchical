import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  saveSkill,
  loadSkill,
  loadSkillByRef,
  listSkills,
  setSkillStatus,
  assertSkillsActive,
  recordEvaluation
} from "../plugins/codex/scripts/skills/skill-registry.mjs";

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

function makeSkill(overrides = {}) {
  return {
    id: "technical/node-test-authoring",
    version: "1.0.0",
    status: "draft",
    purpose: "Author node:test suites",
    useWhen: ["writing new tests"],
    dontUseWhen: ["writing production code"],
    requiredInputs: ["target module path"],
    procedure: ["write a fixture", "write a test", "run node --test"],
    verificationSteps: ["npm test passes"],
    doneWhen: ["tests are green"],
    escalateWhen: ["tests reveal a design gap"],
    outputContract: "a *.test.mjs file",
    sources: ["tests/state.test.mjs"],
    owner: "manager",
    ...overrides
  };
}

test("saveSkill + loadSkill round-trip by id", () => {
  withTempDir((rootDir) => {
    const skill = makeSkill();
    const filePath = saveSkill(rootDir, skill);

    assert.equal(
      filePath,
      path.join(rootDir, ".ai-company", "skills", "technical", "node-test-authoring.json")
    );
    assert.ok(fs.readFileSync(filePath, "utf8").endsWith("\n"));

    const loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.deepEqual(loaded, skill);
  });
});

test("loadSkill returns null for a missing skill", () => {
  withTempDir((rootDir) => {
    assert.equal(loadSkill(rootDir, "technical/does-not-exist"), null);
  });
});

test("loadSkillByRef returns the skill only when id and version both match", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill());

    const matched = loadSkillByRef(rootDir, "technical/node-test-authoring@1.0.0");
    assert.equal(matched.id, "technical/node-test-authoring");

    assert.equal(loadSkillByRef(rootDir, "technical/node-test-authoring@2.0.0"), null);
    assert.equal(loadSkillByRef(rootDir, "technical/does-not-exist@1.0.0"), null);
  });
});

test("listSkills lists across tiers sorted by id, with optional status filter", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ id: "technical/zeta-skill", status: "active" }));
    saveSkill(rootDir, makeSkill({ id: "core/alpha-skill", status: "draft" }));
    saveSkill(rootDir, makeSkill({ id: "project/mid-skill", status: "active" }));

    const all = listSkills(rootDir);
    assert.deepEqual(all.map((s) => s.id), [
      "core/alpha-skill",
      "project/mid-skill",
      "technical/zeta-skill"
    ]);

    const active = listSkills(rootDir, { status: "active" });
    assert.deepEqual(active.map((s) => s.id), ["project/mid-skill", "technical/zeta-skill"]);
  });
});

test("listSkills returns [] when the skills dir is missing", () => {
  withTempDir((rootDir) => {
    assert.deepEqual(listSkills(rootDir), []);
  });
});

test("setSkillStatus walks the legal lifecycle single-step at a time", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "draft" }));

    setSkillStatus(rootDir, "technical/node-test-authoring", "evaluating");
    assert.equal(loadSkill(rootDir, "technical/node-test-authoring").status, "evaluating");

    setSkillStatus(rootDir, "technical/node-test-authoring", "approved", { approvedBy: "manager-01" });
    let loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(loaded.status, "approved");
    assert.equal(loaded.approvedBy, "manager-01");

    setSkillStatus(rootDir, "technical/node-test-authoring", "active", { approvedBy: "manager-01" });
    loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(loaded.status, "active");

    setSkillStatus(rootDir, "technical/node-test-authoring", "deprecated");
    loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(loaded.status, "deprecated");
  });
});

test("setSkillStatus requires approvedBy for evaluating -> approved", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "evaluating" }));

    assert.throws(
      () => setSkillStatus(rootDir, "technical/node-test-authoring", "approved"),
      /approvedBy/i
    );
  });
});

test("setSkillStatus requires approvedBy for approved -> active", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "approved", approvedBy: "manager-01" }));

    assert.throws(
      () => setSkillStatus(rootDir, "technical/node-test-authoring", "active"),
      /approvedBy/i
    );
  });
});

test("setSkillStatus throws on illegal transition: skipping a step", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "draft" }));

    assert.throws(
      () => setSkillStatus(rootDir, "technical/node-test-authoring", "approved", { approvedBy: "x" }),
      /Illegal skill status transition: draft -> approved/
    );
  });
});

test("setSkillStatus throws on illegal transition: backward move", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "active" }));

    assert.throws(
      () => setSkillStatus(rootDir, "technical/node-test-authoring", "draft"),
      /Illegal skill status transition: active -> draft/
    );
  });
});

test("assertSkillsActive returns loaded skills when all refs are active", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "active" }));
    saveSkill(rootDir, makeSkill({ id: "core/scope-control", status: "active" }));

    const result = assertSkillsActive(rootDir, [
      "technical/node-test-authoring@1.0.0",
      "core/scope-control@1.0.0"
    ]);

    assert.equal(result.length, 2);
    assert.deepEqual(result.map((s) => s.id).sort(), ["core/scope-control", "technical/node-test-authoring"]);
  });
});

test("assertSkillsActive throws naming every missing or non-active ref in a mix", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "active" }));
    saveSkill(rootDir, makeSkill({ id: "core/scope-control", status: "draft" }));

    assert.throws(
      () =>
        assertSkillsActive(rootDir, [
          "technical/node-test-authoring@1.0.0",
          "core/scope-control@1.0.0",
          "project/does-not-exist@1.0.0"
        ]),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /core\/scope-control@1\.0\.0/);
        assert.match(err.message, /project\/does-not-exist@1\.0\.0/);
        assert.doesNotMatch(err.message, /technical\/node-test-authoring@1\.0\.0/);
        return true;
      }
    );
  });
});

test("recordEvaluation appends to the skill's evaluations array", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill());

    recordEvaluation(rootDir, "technical/node-test-authoring", {
      taskId: "task-1",
      outcome: "pass",
      at: "2026-07-13T00:00:00.000Z"
    });
    recordEvaluation(rootDir, "technical/node-test-authoring", {
      taskId: "task-2",
      outcome: "fail",
      at: "2026-07-13T01:00:00.000Z"
    });

    const loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(loaded.evaluations.length, 2);
    assert.equal(loaded.evaluations[0].taskId, "task-1");
    assert.equal(loaded.evaluations[1].outcome, "fail");
  });
});
