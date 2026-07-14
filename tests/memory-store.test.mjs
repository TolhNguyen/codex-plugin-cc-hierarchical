import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  readMemory,
  listMemoryEntries,
  appendMemoryEntry,
  renderMemoryForPrompt
} from "../plugins/codex/scripts/memory/memory-store.mjs";
import { makeTempDir } from "./helpers.mjs";

function withTempDir(fn) {
  const rootDir = makeTempDir("memory-store-test-");
  try {
    fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// --- namespace -> path mapping -------------------------------------------

test("appendMemoryEntry: agent/<id> namespace writes under memory/agents/<id>.json", () => {
  withTempDir((rootDir) => {
    appendMemoryEntry(rootDir, "agent/worker-a", {
      content: "Always run npm test before committing.",
      type: "convention",
      sourceProposalId: "MEM-PROP-1",
      agentId: "worker-a"
    });

    const filePath = path.join(rootDir, ".ai-company", "memory", "agents", "worker-a.json");
    assert.equal(fs.existsSync(filePath), true);
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(doc.namespace, "agent/worker-a");
    assert.equal(doc.version, 1);
    assert.equal(doc.entries.length, 1);
  });
});

test("appendMemoryEntry: domain/<name> namespace writes under memory/domains/<name>.json", () => {
  withTempDir((rootDir) => {
    appendMemoryEntry(rootDir, "domain/billing", {
      content: "Billing amounts are always integer cents.",
      type: "fact",
      sourceProposalId: "MEM-PROP-2",
      agentId: "worker-b"
    });

    const filePath = path.join(rootDir, ".ai-company", "memory", "domains", "billing.json");
    assert.equal(fs.existsSync(filePath), true);
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(doc.namespace, "domain/billing");
  });
});

test("appendMemoryEntry: anything else (project/campaign) writes under memory/shared/<slug>.json", () => {
  withTempDir((rootDir) => {
    appendMemoryEntry(rootDir, "project/shared", {
      content: "Use ESM everywhere.",
      type: "convention",
      sourceProposalId: "MEM-PROP-3",
      agentId: "worker-c"
    });
    appendMemoryEntry(rootDir, "campaign/camp-1", {
      content: "This campaign targets the hierarchical runtime.",
      type: "fact",
      sourceProposalId: "MEM-PROP-4",
      agentId: "worker-d"
    });

    const sharedProjectPath = path.join(rootDir, ".ai-company", "memory", "shared", "project__shared.json");
    const sharedCampaignPath = path.join(rootDir, ".ai-company", "memory", "shared", "campaign__camp-1.json");
    assert.equal(fs.existsSync(sharedProjectPath), true);
    assert.equal(fs.existsSync(sharedCampaignPath), true);
  });
});

test("readMemory/appendMemoryEntry: reject invalid namespaces (path traversal guard)", () => {
  withTempDir((rootDir) => {
    const invalidNamespaces = [
      "../etc/passwd",
      "/absolute/path",
      "agent\\worker-a",
      "agent",
      "Agent/Worker",
      "agent/../secret",
      ""
    ];

    for (const ns of invalidNamespaces) {
      assert.throws(
        () => readMemory(rootDir, ns),
        new RegExp(`Invalid memory namespace`),
        `expected readMemory to reject namespace ${JSON.stringify(ns)}`
      );
      assert.throws(
        () =>
          appendMemoryEntry(rootDir, ns, {
            content: "x",
            type: "fact",
            sourceProposalId: "MEM-PROP-x",
            agentId: "worker-x"
          }),
        /Invalid memory namespace/,
        `expected appendMemoryEntry to reject namespace ${JSON.stringify(ns)}`
      );
    }
  });
});

// --- readMemory -----------------------------------------------------------

test("readMemory: missing namespace file returns version 0 with empty entries", () => {
  withTempDir((rootDir) => {
    const doc = readMemory(rootDir, "agent/never-written");
    assert.deepEqual(doc, { namespace: "agent/never-written", version: 0, entries: [] });
  });
});

// --- appendMemoryEntry ------------------------------------------------------

test("appendMemoryEntry: bumps version, assigns entryId/createdAt, persists, returns stored entry", () => {
  withTempDir((rootDir) => {
    const stored1 = appendMemoryEntry(rootDir, "agent/worker-a", {
      content: "First fact.",
      type: "fact",
      sourceProposalId: "MEM-PROP-1",
      agentId: "worker-a"
    });

    assert.match(stored1.entryId, /^mem-[0-9a-z]+-[0-9a-z]{6}$/);
    assert.equal(typeof stored1.createdAt, "string");
    assert.equal(stored1.content, "First fact.");
    assert.equal(stored1.type, "fact");
    assert.equal(stored1.sourceProposalId, "MEM-PROP-1");
    assert.equal(stored1.agentId, "worker-a");

    const afterFirst = readMemory(rootDir, "agent/worker-a");
    assert.equal(afterFirst.version, 1);
    assert.equal(afterFirst.entries.length, 1);

    const stored2 = appendMemoryEntry(rootDir, "agent/worker-a", {
      content: "Second fact.",
      type: "fact",
      sourceProposalId: "MEM-PROP-2",
      agentId: "worker-a",
      supersedes: stored1.entryId
    });

    assert.notEqual(stored2.entryId, stored1.entryId);
    assert.equal(stored2.supersedes, stored1.entryId);

    const afterSecond = readMemory(rootDir, "agent/worker-a");
    assert.equal(afterSecond.version, 2);
    assert.equal(afterSecond.entries.length, 2);
    assert.equal(afterSecond.entries[0].entryId, stored1.entryId);
    assert.equal(afterSecond.entries[1].entryId, stored2.entryId);
  });
});

test("appendMemoryEntry: validates required fields", () => {
  withTempDir((rootDir) => {
    const base = { content: "x", type: "fact", sourceProposalId: "MEM-PROP-1", agentId: "worker-a" };

    assert.throws(() => appendMemoryEntry(rootDir, "agent/worker-a", { ...base, content: "" }));
    assert.throws(() => appendMemoryEntry(rootDir, "agent/worker-a", { ...base, content: undefined }));
    assert.throws(() => appendMemoryEntry(rootDir, "agent/worker-a", { ...base, type: undefined }));
    assert.throws(() => appendMemoryEntry(rootDir, "agent/worker-a", { ...base, sourceProposalId: undefined }));
    assert.throws(() => appendMemoryEntry(rootDir, "agent/worker-a", { ...base, agentId: undefined }));
  });
});

// --- listMemoryEntries ------------------------------------------------------

test("listMemoryEntries: flattens across namespaces, preserving namespace order and stored order, annotating entries", () => {
  withTempDir((rootDir) => {
    appendMemoryEntry(rootDir, "agent/worker-a", {
      content: "a1",
      type: "fact",
      sourceProposalId: "p1",
      agentId: "worker-a"
    });
    appendMemoryEntry(rootDir, "agent/worker-a", {
      content: "a2",
      type: "fact",
      sourceProposalId: "p2",
      agentId: "worker-a"
    });
    appendMemoryEntry(rootDir, "project/shared", {
      content: "s1",
      type: "convention",
      sourceProposalId: "p3",
      agentId: "worker-b"
    });

    const entries = listMemoryEntries(rootDir, ["project/shared", "agent/worker-a", "domain/never-written"]);

    assert.equal(entries.length, 3);
    assert.equal(entries[0].namespace, "project/shared");
    assert.equal(entries[0].content, "s1");
    assert.equal(entries[1].namespace, "agent/worker-a");
    assert.equal(entries[1].content, "a1");
    assert.equal(entries[2].namespace, "agent/worker-a");
    assert.equal(entries[2].content, "a2");
  });
});

test("listMemoryEntries: skips unknown/empty namespaces without throwing", () => {
  withTempDir((rootDir) => {
    const entries = listMemoryEntries(rootDir, ["domain/never-written", "agent/also-never-written"]);
    assert.deepEqual(entries, []);
  });
});

// --- renderMemoryForPrompt --------------------------------------------------

test("renderMemoryForPrompt: empty entries render the placeholder", () => {
  assert.equal(renderMemoryForPrompt([]), "(no memory entries)");
});

test("renderMemoryForPrompt: normal case renders one line per entry", () => {
  const entries = [
    { namespace: "agent/worker-a", type: "fact", content: "First." },
    { namespace: "project/shared", type: "convention", content: "Second." }
  ];
  const rendered = renderMemoryForPrompt(entries);
  assert.equal(rendered, "- [agent/worker-a/fact] First.\n- [project/shared/convention] Second.");
});

test("renderMemoryForPrompt: truncates by maxEntries, dropping oldest first, with an omission line", () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({
    namespace: "agent/worker-a",
    type: "fact",
    content: `entry-${i}`
  }));

  const rendered = renderMemoryForPrompt(entries, { maxEntries: 2, maxChars: 4000 });
  const lines = rendered.split("\n");

  assert.equal(lines.length, 3);
  assert.equal(lines[0], "- [agent/worker-a/fact] entry-3");
  assert.equal(lines[1], "- [agent/worker-a/fact] entry-4");
  assert.equal(lines[2], "... (3 more entries omitted)");
});

test("renderMemoryForPrompt: truncates by maxChars, dropping oldest first, with an omission line", () => {
  const entries = [
    { namespace: "agent/worker-a", type: "fact", content: "aaaaaaaaaa" },
    { namespace: "agent/worker-a", type: "fact", content: "bbbbbbbbbb" },
    { namespace: "agent/worker-a", type: "fact", content: "cccccccccc" }
  ];

  const rendered = renderMemoryForPrompt(entries, { maxEntries: 20, maxChars: 40 });
  assert.ok(rendered.includes("cccccccccc"));
  assert.ok(!rendered.includes("aaaaaaaaaa"));
  assert.match(rendered, /more entries omitted\)$/);
});

// --- Deliverable E: worker enforcement guard ------------------------------

test("Deliverable E: permission-guard denies a worker writing official memory files directly", async () => {
  const { createPermissionGuard } = await import("../plugins/codex/scripts/agents/permission-guard.mjs");

  withTempDir((rootDir) => {
    // Even a worker with a broad write grant must never be able to touch
    // .ai-company/** directly: the always-deny glob wins regardless of what
    // the agent's own permissions.write allows.
    const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["**"] });

    assert.equal(guard.canWrite(".ai-company/memory/shared/project__shared.json"), false);
    assert.throws(
      () => guard.assertWrite(".ai-company/memory/shared/project__shared.json"),
      /Permission denied: write/
    );
  });
});
