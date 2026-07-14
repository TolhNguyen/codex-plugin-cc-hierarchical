import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createMemoryReviewer, reviewPendingProposals } from "../plugins/codex/scripts/memory/memory-review.mjs";
import { recordProposals, loadProposal } from "../plugins/codex/scripts/memory/proposal-store.mjs";
import { readMemory } from "../plugins/codex/scripts/memory/memory-store.mjs";
import { createRuntimeResult } from "../plugins/codex/scripts/runtimes/runtime-base.mjs";
import { makeTempDir } from "./helpers.mjs";

async function withTempDir(fn) {
  const rootDir = makeTempDir("memory-review-test-");
  try {
    await fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

let counter = 0;
function makeManagerResult(overrides = {}) {
  counter += 1;
  return createRuntimeResult({
    executionId: overrides.executionId ?? `exec-mem-${counter}`,
    agentId: overrides.agentId ?? "manager-codex",
    role: "manager",
    status: overrides.status ?? "completed",
    output: overrides.output ?? "",
    startedAt: overrides.startedAt ?? "2026-07-14T00:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-07-14T00:00:01.000Z",
    error: overrides.error ?? null
  });
}

function makeProposal(rootDir, overrides = {}) {
  const { stored } = recordProposals(rootDir, {
    campaignId: "camp-1",
    taskId: "task-1",
    agentId: "worker-a",
    proposals: [
      {
        scope: "project/shared",
        type: "convention",
        content: "Always run npm test before committing.",
        evidence: ["task-1 failed CI without it"],
        confidence: 0.8,
        ...overrides
      }
    ]
  });
  return stored[0];
}

// --- createMemoryReviewer --------------------------------------------------

test("createMemoryReviewer: a valid decision passes through unchanged", async () => {
  await withTempDir(async (rootDir) => {
    const proposal = makeProposal(rootDir);
    const decision = { action: "approve", reason: "durable convention" };

    const calls = [];
    const runtime = {
      execute: async (agent, task, context) => {
        calls.push({ agent, task, context });
        return makeManagerResult({ output: JSON.stringify(decision) });
      }
    };

    const decide = createMemoryReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });
    const result = await decide(proposal);

    assert.deepEqual(result, decision);
    assert.equal(calls.length, 1);
    assert.match(calls[0].context.prompt, new RegExp(proposal.proposalId));
    assert.equal(calls[0].task.taskId, "task-1");
  });
});

test("createMemoryReviewer: falls back to 'memory-review' taskId when the proposal has none", async () => {
  await withTempDir(async (rootDir) => {
    const proposal = { proposalId: "MEM-PROP-x", scope: "project/shared", content: "c", type: "fact" };
    const decision = { action: "reject", reason: "no evidence" };

    const calls = [];
    const runtime = {
      execute: async (agent, task, context) => {
        calls.push({ agent, task, context });
        return makeManagerResult({ output: JSON.stringify(decision) });
      }
    };

    const decide = createMemoryReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });
    await decide(proposal);

    assert.equal(calls[0].task.taskId, "memory-review");
  });
});

test("createMemoryReviewer: retries once with validation errors appended, then succeeds", async () => {
  await withTempDir(async (rootDir) => {
    const proposal = makeProposal(rootDir);
    const bad = { action: "approve" }; // missing required "reason"
    const good = { action: "approve", reason: "durable convention" };

    let call = 0;
    const prompts = [];
    const runtime = {
      execute: async (agent, task, context) => {
        prompts.push(context.prompt);
        call += 1;
        return makeManagerResult({ output: JSON.stringify(call === 1 ? bad : good) });
      }
    };

    const decide = createMemoryReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });
    const result = await decide(proposal);

    assert.deepEqual(result, good);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /missing required property "reason"/);
  });
});

test("createMemoryReviewer: throws when invalid twice", async () => {
  await withTempDir(async (rootDir) => {
    const proposal = makeProposal(rootDir);
    const bad = { action: "bogus-action", reason: "x" };

    const runtime = {
      execute: async () => makeManagerResult({ output: JSON.stringify(bad) })
    };

    const decide = createMemoryReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });

    await assert.rejects(() => decide(proposal), /invalid after one retry/);
  });
});

test("createMemoryReviewer: throws 'Memory review failed' when the runtime does not complete", async () => {
  await withTempDir(async (rootDir) => {
    const proposal = makeProposal(rootDir);

    const runtime = {
      execute: async () => makeManagerResult({ status: "failed", output: "", error: "codex crashed" })
    };

    const decide = createMemoryReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });

    await assert.rejects(() => decide(proposal), /Memory review failed: codex crashed/);
  });
});

// --- reviewPendingProposals -------------------------------------------------

test("reviewPendingProposals: processes pending proposals in id order and applies decisions", async () => {
  await withTempDir(async (rootDir) => {
    const p1 = makeProposal(rootDir, { content: "First." });
    const p2 = makeProposal(rootDir, { content: "Second." });
    const sortedIds = [p1.proposalId, p2.proposalId].sort();

    const decisionsById = {
      [sortedIds[0]]: { action: "approve", reason: "good" },
      [sortedIds[1]]: { action: "reject", reason: "speculative" }
    };

    const seen = [];
    const decide = async (proposal) => {
      seen.push(proposal.proposalId);
      return decisionsById[proposal.proposalId];
    };

    const result = await reviewPendingProposals(rootDir, {
      campaignId: "camp-1",
      decide,
      decidedBy: "manager-codex"
    });

    assert.deepEqual(seen, sortedIds);
    assert.equal(result.halted, false);
    assert.deepEqual(
      result.processed,
      sortedIds.map((id) => ({ proposalId: id, action: decisionsById[id].action }))
    );

    const first = loadProposal(rootDir, sortedIds[0]);
    const second = loadProposal(rootDir, sortedIds[1]);
    assert.equal(first.status, "approved");
    assert.equal(second.status, "rejected");
  });
});

test("reviewPendingProposals: writes memory only for approve/edit_and_approve outcomes", async () => {
  await withTempDir(async (rootDir) => {
    makeProposal(rootDir, { scope: "project/shared", content: "Approved one." });
    makeProposal(rootDir, { scope: "project/shared", content: "Rejected one." });

    let call = 0;
    const decide = async () => {
      call += 1;
      return call === 1
        ? { action: "approve", reason: "good" }
        : { action: "reject", reason: "bad" };
    };

    await reviewPendingProposals(rootDir, { campaignId: "camp-1", decide, decidedBy: "manager-codex" });

    const memory = readMemory(rootDir, "project/shared");
    assert.equal(memory.entries.length, 1);
    assert.equal(memory.entries[0].content, "Approved one.");
  });
});

test("reviewPendingProposals: a guard throw halts processing with a partial processed list", async () => {
  await withTempDir(async (rootDir) => {
    const p1 = makeProposal(rootDir, { content: "First." });
    const p2 = makeProposal(rootDir, { content: "Second." });
    const sortedIds = [p1.proposalId, p2.proposalId].sort();

    let calls = 0;
    const guards = {
      beforeManagerCall: () => {
        calls += 1;
        if (calls === 2) {
          throw new Error("budget exhausted");
        }
      }
    };

    const decide = async () => ({ action: "approve", reason: "good" });

    const result = await reviewPendingProposals(rootDir, {
      campaignId: "camp-1",
      decide,
      decidedBy: "manager-codex",
      guards
    });

    assert.equal(result.halted, true);
    assert.equal(result.processed.length, 1);
    assert.equal(result.processed[0].proposalId, sortedIds[0]);

    const second = loadProposal(rootDir, sortedIds[1]);
    assert.equal(second.status, "pending");
  });
});

test("reviewPendingProposals: a mid-batch applyDecision failure is recorded as 'failed' and processing continues", async () => {
  await withTempDir(async (rootDir) => {
    const proposalsDir = path.join(rootDir, ".ai-company", "memory", "proposals");
    fs.mkdirSync(proposalsDir, { recursive: true });

    function writeRawProposal(proposalId, overrides = {}) {
      const doc = {
        proposalId,
        agentId: "worker-a",
        scope: "project/shared",
        content: `Content for ${proposalId}`,
        type: "convention",
        evidence: ["e"],
        confidence: 0.5,
        status: "pending",
        campaignId: "camp-1",
        taskId: "task-1",
        ...overrides
      };
      fs.writeFileSync(path.join(proposalsDir, `${proposalId}.json`), JSON.stringify(doc, null, 2));
      return doc;
    }

    // Middle proposal (by sorted proposalId) has a scope that can never have
    // slipped past recordProposals's validation -- simulating a pre-existing
    // bad proposal -- so applyDecision throws for it specifically.
    writeRawProposal("MEM-PROP-1");
    writeRawProposal("MEM-PROP-2", { scope: "no-slash" });
    writeRawProposal("MEM-PROP-3");

    const decide = async () => ({ action: "approve", reason: "good" });

    const result = await reviewPendingProposals(rootDir, {
      campaignId: "camp-1",
      decide,
      decidedBy: "manager-codex"
    });

    assert.equal(result.halted, false);
    assert.equal(result.processed.length, 3);

    assert.equal(result.processed[0].proposalId, "MEM-PROP-1");
    assert.equal(result.processed[0].action, "approve");

    assert.equal(result.processed[1].proposalId, "MEM-PROP-2");
    assert.equal(result.processed[1].action, "failed");
    assert.match(result.processed[1].error, /Invalid memory namespace/);

    assert.equal(result.processed[2].proposalId, "MEM-PROP-3");
    assert.equal(result.processed[2].action, "approve");

    assert.equal(loadProposal(rootDir, "MEM-PROP-1").status, "approved");
    assert.equal(loadProposal(rootDir, "MEM-PROP-2").status, "pending");
    assert.equal(loadProposal(rootDir, "MEM-PROP-3").status, "approved");
  });
});

test("reviewPendingProposals: already-decided proposals are skipped (only pending is processed)", async () => {
  await withTempDir(async (rootDir) => {
    const p1 = makeProposal(rootDir, { content: "First." });
    const p2 = makeProposal(rootDir, { content: "Second." });

    const decide = async () => ({ action: "approve", reason: "good" });
    await reviewPendingProposals(rootDir, { campaignId: "camp-1", decide, decidedBy: "manager-codex" });

    // Both now decided; a second pass must call `decide` zero times.
    let secondPassCalls = 0;
    const decideAgain = async () => {
      secondPassCalls += 1;
      return { action: "reject", reason: "should never run" };
    };

    const result = await reviewPendingProposals(rootDir, {
      campaignId: "camp-1",
      decide: decideAgain,
      decidedBy: "manager-codex"
    });

    assert.equal(secondPassCalls, 0);
    assert.deepEqual(result.processed, []);
    assert.equal(result.halted, false);

    const first = loadProposal(rootDir, p1.proposalId);
    const second = loadProposal(rootDir, p2.proposalId);
    assert.equal(first.status, "approved");
    assert.equal(second.status, "approved");
  });
});
