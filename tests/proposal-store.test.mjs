import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  recordProposals,
  listProposals,
  loadProposal,
  applyDecision
} from "../plugins/codex/scripts/memory/proposal-store.mjs";
import { readMemory } from "../plugins/codex/scripts/memory/memory-store.mjs";
import { readAuditEvents } from "../plugins/codex/scripts/orchestration/audit-log.mjs";
import { makeTempDir } from "./helpers.mjs";

function withTempDir(fn) {
  const rootDir = makeTempDir("proposal-store-test-");
  try {
    fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function validRawProposal(overrides = {}) {
  return {
    scope: "project/shared",
    type: "convention",
    content: "Always run npm test before committing.",
    evidence: ["task-1 failed CI without it"],
    confidence: 0.8,
    ...overrides
  };
}

// --- recordProposals: untrusted-field forcing -----------------------------

test("recordProposals: forces proposalId/agentId/status server-side, ignoring worker-supplied values", () => {
  withTempDir((rootDir) => {
    const worker = validRawProposal({
      proposalId: "worker-supplied-id",
      agentId: "not-the-real-agent",
      status: "approved"
    });

    const { stored, rejected } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [worker]
    });

    assert.deepEqual(rejected, []);
    assert.equal(stored.length, 1);
    const doc = stored[0];

    assert.notEqual(doc.proposalId, "worker-supplied-id");
    assert.match(doc.proposalId, /^MEM-PROP-[0-9a-z]+-[0-9a-z]{4}$/);
    assert.equal(doc.agentId, "worker-a");
    assert.equal(doc.status, "pending");
    assert.equal(doc.scope, "project/shared");
    assert.equal(doc.content, worker.content);
  });
});

test("recordProposals: stores valid proposals to disk under .ai-company/memory/proposals/<id>.json", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal()]
    });

    const filePath = path.join(rootDir, ".ai-company", "memory", "proposals", `${stored[0].proposalId}.json`);
    assert.equal(fs.existsSync(filePath), true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(onDisk.proposalId, stored[0].proposalId);
    assert.equal(onDisk.status, "pending");
  });
});

test("recordProposals: returns rejected for invalid proposals without throwing, and never stores them", () => {
  withTempDir((rootDir) => {
    const malformed = [
      { scope: "project/shared" }, // missing everything else
      { ...validRawProposal(), confidence: 5 }, // out of range
      { ...validRawProposal(), type: "not-a-real-type" }, // bad enum
      null,
      "not an object",
      42
    ];

    let result;
    assert.doesNotThrow(() => {
      result = recordProposals(rootDir, {
        campaignId: "camp-1",
        taskId: "task-1",
        agentId: "worker-a",
        proposals: malformed
      });
    });

    assert.equal(result.stored.length, 0);
    assert.equal(result.rejected.length, malformed.length);
    for (let i = 0; i < malformed.length; i += 1) {
      assert.equal(result.rejected[i].index, i);
      assert.ok(Array.isArray(result.rejected[i].errors));
      assert.ok(result.rejected[i].errors.length > 0);
    }

    const proposalsDir = path.join(rootDir, ".ai-company", "memory", "proposals");
    assert.equal(fs.existsSync(proposalsDir) && fs.readdirSync(proposalsDir).length > 0, false);
  });
});

test("recordProposals: audits memory_proposal_recorded once per stored proposal", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal(), validRawProposal({ content: "Second one." })]
    });

    const events = readAuditEvents(rootDir, "camp-1").filter((e) => e.event === "memory_proposal_recorded");
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.proposalId).sort(),
      stored.map((s) => s.proposalId).sort()
    );
    for (const event of events) {
      assert.equal(event.agentId, "worker-a");
      assert.equal(event.taskId, "task-1");
    }
  });
});

test("recordProposals: rejects proposals whose scope is not a valid memory namespace, without throwing or storing", () => {
  withTempDir((rootDir) => {
    const malformedScopes = ["../../etc/passwd", "no-slash", "", "agent\\..\\x"];
    const proposals = malformedScopes.map((scope) => validRawProposal({ scope }));

    let result;
    assert.doesNotThrow(() => {
      result = recordProposals(rootDir, {
        campaignId: "camp-1",
        taskId: "task-1",
        agentId: "worker-a",
        proposals
      });
    });

    assert.equal(result.stored.length, 0);
    assert.equal(result.rejected.length, malformedScopes.length);
    for (let i = 0; i < malformedScopes.length; i += 1) {
      assert.equal(result.rejected[i].index, i);
      assert.ok(Array.isArray(result.rejected[i].errors));
      assert.ok(
        result.rejected[i].errors.some((e) => /Invalid memory namespace/.test(e)),
        `expected an "Invalid memory namespace" error for scope ${JSON.stringify(malformedScopes[i])}, got ${JSON.stringify(result.rejected[i].errors)}`
      );
    }

    const proposalsDir = path.join(rootDir, ".ai-company", "memory", "proposals");
    assert.equal(fs.existsSync(proposalsDir) && fs.readdirSync(proposalsDir).length > 0, false);
  });
});

// --- listProposals / loadProposal -----------------------------------------

test("listProposals: sorted by proposalId, with optional status filter", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal({ content: "one" }), validRawProposal({ content: "two" })]
    });

    const all = listProposals(rootDir);
    assert.equal(all.length, 2);
    const sortedIds = [...stored.map((s) => s.proposalId)].sort();
    assert.deepEqual(all.map((p) => p.proposalId), sortedIds);

    applyDecision(rootDir, stored[0].proposalId, { action: "approve", reason: "good" }, {
      campaignId: "camp-1",
      decidedBy: "manager-codex"
    });

    const pendingOnly = listProposals(rootDir, { status: "pending" });
    assert.equal(pendingOnly.length, 1);
    assert.equal(pendingOnly[0].proposalId, stored[1].proposalId);

    const approvedOnly = listProposals(rootDir, { status: "approved" });
    assert.equal(approvedOnly.length, 1);
    assert.equal(approvedOnly[0].proposalId, stored[0].proposalId);
  });
});

test("loadProposal: returns the document or null when it does not exist", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal()]
    });

    const loaded = loadProposal(rootDir, stored[0].proposalId);
    assert.equal(loaded.proposalId, stored[0].proposalId);

    assert.equal(loadProposal(rootDir, "MEM-PROP-does-not-exist"), null);
  });
});

// --- applyDecision ----------------------------------------------------------

test("applyDecision: requires decidedBy", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal()]
    });

    assert.throws(
      () => applyDecision(rootDir, stored[0].proposalId, { action: "approve", reason: "ok" }, { campaignId: "camp-1" }),
      /decidedBy/
    );
  });
});

test("applyDecision: approve writes a memory entry with sourceProposalId and bumps the namespace version", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal({ scope: "project/shared", content: "Approved content." })]
    });

    const before = readMemory(rootDir, "project/shared");
    assert.equal(before.version, 0);

    const { proposal, entry } = applyDecision(
      rootDir,
      stored[0].proposalId,
      { action: "approve", reason: "solid convention" },
      { campaignId: "camp-1", decidedBy: "manager-codex" }
    );

    assert.equal(proposal.status, "approved");
    assert.equal(proposal.decidedBy, "manager-codex");
    assert.equal(typeof proposal.decidedAt, "string");
    assert.equal(proposal.finalContent, "Approved content.");

    assert.ok(entry);
    assert.equal(entry.content, "Approved content.");
    assert.equal(entry.sourceProposalId, stored[0].proposalId);
    assert.equal(entry.agentId, "worker-a");

    const after = readMemory(rootDir, "project/shared");
    assert.equal(after.version, 1);
    assert.equal(after.entries.length, 1);
  });
});

test("applyDecision: edit_and_approve requires non-empty finalContent, throws without it", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal()]
    });

    assert.throws(
      () =>
        applyDecision(rootDir, stored[0].proposalId, { action: "edit_and_approve", reason: "tighten" }, {
          campaignId: "camp-1",
          decidedBy: "manager-codex"
        }),
      /finalContent/
    );

    // Still pending after the throw -- no partial decision was persisted.
    const loaded = loadProposal(rootDir, stored[0].proposalId);
    assert.equal(loaded.status, "pending");
  });
});

test("applyDecision: edit_and_approve stores the edited content, not the original", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal({ scope: "project/shared", content: "Original wording." })]
    });

    const { proposal, entry } = applyDecision(
      rootDir,
      stored[0].proposalId,
      { action: "edit_and_approve", reason: "tightened wording", finalContent: "Tightened wording." },
      { campaignId: "camp-1", decidedBy: "manager-codex" }
    );

    assert.equal(proposal.status, "edited");
    assert.equal(proposal.finalContent, "Tightened wording.");
    assert.equal(entry.content, "Tightened wording.");

    const memory = readMemory(rootDir, "project/shared");
    assert.equal(memory.entries[0].content, "Tightened wording.");
  });
});

test("applyDecision: reject writes no memory entry but persists status", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal({ scope: "project/shared" })]
    });

    const { proposal, entry } = applyDecision(
      rootDir,
      stored[0].proposalId,
      { action: "reject", reason: "speculative" },
      { campaignId: "camp-1", decidedBy: "manager-codex" }
    );

    assert.equal(proposal.status, "rejected");
    assert.equal(entry, null);

    const memory = readMemory(rootDir, "project/shared");
    assert.equal(memory.version, 0);
    assert.equal(memory.entries.length, 0);

    // Kept on disk for audit.
    const loaded = loadProposal(rootDir, stored[0].proposalId);
    assert.equal(loaded.status, "rejected");
  });
});

test("applyDecision: escalate writes no memory entry but persists status", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal({ scope: "project/shared" })]
    });

    const { proposal, entry } = applyDecision(
      rootDir,
      stored[0].proposalId,
      { action: "escalate", reason: "policy question" },
      { campaignId: "camp-1", decidedBy: "manager-codex" }
    );

    assert.equal(proposal.status, "escalated");
    assert.equal(entry, null);

    const memory = readMemory(rootDir, "project/shared");
    assert.equal(memory.version, 0);
  });
});

test("applyDecision: deciding an already-decided proposal throws (no double-decisions)", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal()]
    });

    applyDecision(rootDir, stored[0].proposalId, { action: "approve", reason: "ok" }, {
      campaignId: "camp-1",
      decidedBy: "manager-codex"
    });

    assert.throws(
      () =>
        applyDecision(rootDir, stored[0].proposalId, { action: "reject", reason: "changed my mind" }, {
          campaignId: "camp-1",
          decidedBy: "manager-codex"
        }),
      /not pending \(status: approved\)/
    );
  });
});

test("applyDecision: a proposal with an invalid scope (bypassing recordProposals) throws, stays pending, and writes no memory entry", () => {
  withTempDir((rootDir) => {
    const proposalId = "MEM-PROP-badscope-0001";
    const proposalsDir = path.join(rootDir, ".ai-company", "memory", "proposals");
    fs.mkdirSync(proposalsDir, { recursive: true });

    // Construct the pending proposal directly on disk, bypassing
    // recordProposals's scope validation -- this simulates a proposal that
    // somehow got a malformed scope onto disk (e.g. from a pre-fix version).
    const badProposal = {
      proposalId,
      agentId: "worker-a",
      scope: "no-slash",
      content: "Some content.",
      type: "convention",
      evidence: ["e"],
      confidence: 0.5,
      status: "pending",
      campaignId: "camp-1",
      taskId: "task-1"
    };
    fs.writeFileSync(path.join(proposalsDir, `${proposalId}.json`), JSON.stringify(badProposal, null, 2));

    assert.throws(
      () =>
        applyDecision(rootDir, proposalId, { action: "approve", reason: "ok" }, {
          campaignId: "camp-1",
          decidedBy: "manager-codex"
        }),
      /Invalid memory namespace/
    );

    // Still pending -- the failed memory write must not leave a
    // half-persisted "approved" status with no corresponding memory entry.
    const loaded = loadProposal(rootDir, proposalId);
    assert.equal(loaded.status, "pending");

    // No memory entry was created anywhere (the memory dir's namespace
    // subdirectories were never even created).
    const memoryDir = path.join(rootDir, ".ai-company", "memory");
    const anyMemorySubdirExists = ["agents", "domains", "shared"].some((d) =>
      fs.existsSync(path.join(memoryDir, d))
    );
    assert.equal(anyMemorySubdirExists, false);
  });
});

test("applyDecision: audits memory_decision with proposalId/action/decidedBy", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-1",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal()]
    });

    applyDecision(rootDir, stored[0].proposalId, { action: "approve", reason: "ok" }, {
      campaignId: "camp-1",
      decidedBy: "manager-codex"
    });

    const events = readAuditEvents(rootDir, "camp-1").filter((e) => e.event === "memory_decision");
    assert.equal(events.length, 1);
    assert.equal(events[0].proposalId, stored[0].proposalId);
    assert.equal(events[0].action, "approve");
    assert.equal(events[0].decidedBy, "manager-codex");
  });
});

test("applyDecision: uses campaignId from the proposal when not passed explicitly", () => {
  withTempDir((rootDir) => {
    const { stored } = recordProposals(rootDir, {
      campaignId: "camp-from-proposal",
      taskId: "task-1",
      agentId: "worker-a",
      proposals: [validRawProposal()]
    });

    applyDecision(rootDir, stored[0].proposalId, { action: "approve", reason: "ok" }, {
      decidedBy: "manager-codex"
    });

    const events = readAuditEvents(rootDir, "camp-from-proposal").filter((e) => e.event === "memory_decision");
    assert.equal(events.length, 1);
  });
});
