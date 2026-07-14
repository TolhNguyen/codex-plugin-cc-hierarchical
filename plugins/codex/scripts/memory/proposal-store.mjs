import fs from "node:fs";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "../lib/fs.mjs";
import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { appendAuditEvent } from "../orchestration/audit-log.mjs";
import { appendMemoryEntry, isValidNamespace } from "./memory-store.mjs";

/**
 * Proposal storage: the ONLY worker-visible path into memory governance.
 * Workers emit `memoryProposals` inside their task-result; `recordProposals`
 * turns those (untrusted) objects into pending proposal documents. Only a
 * manager decision, applied via `applyDecision`, can turn a proposal into a
 * real memory entry (via `appendMemoryEntry`, the sole memory write path).
 * Rejected/escalated proposals stay on disk for audit.
 */

function proposalsDir(rootDir) {
  return path.join(rootDir, ".ai-company", "memory", "proposals");
}

function proposalFilePath(rootDir, proposalId) {
  return path.join(proposalsDir(rootDir), `${proposalId}.json`);
}

function generateProposalId() {
  const random = Math.random().toString(36).slice(2, 6);
  return `MEM-PROP-${Date.now().toString(36)}-${random}`;
}

/**
 * Records worker-submitted memory proposals as pending, server-governed
 * documents. `proposalId`, `agentId`, and `status` are always forced
 * server-side — any worker-supplied values for those fields are ignored.
 * Only `scope`, `type`, `content`, `evidence`, `confidence` are taken from
 * the worker. Malformed proposals are never thrown on; they are collected
 * into `rejected` instead so one bad proposal can never fail a task.
 *
 * @param {string} rootDir
 * @param {{ campaignId: string, taskId: string, agentId: string, proposals: object[] }} options
 * @returns {{ stored: object[], rejected: { index: number, errors: string[] }[] }}
 */
export function recordProposals(rootDir, { campaignId, taskId, agentId, proposals } = {}) {
  const schema = loadOrchestrationSchema("memory-proposal");
  const list = Array.isArray(proposals) ? proposals : [];

  const stored = [];
  const rejected = [];

  list.forEach((raw, index) => {
    const candidate = {
      proposalId: generateProposalId(),
      agentId,
      scope: raw?.scope,
      content: raw?.content,
      type: raw?.type,
      evidence: raw?.evidence,
      confidence: raw?.confidence,
      status: "pending"
    };

    const { valid, errors } = validateAgainstSchema(candidate, schema);
    if (!valid) {
      rejected.push({ index, errors });
      return;
    }

    if (!isValidNamespace(candidate.scope)) {
      rejected.push({ index, errors: [`Invalid memory namespace: ${candidate.scope}`] });
      return;
    }

    const doc = { ...candidate, campaignId, taskId };

    fs.mkdirSync(proposalsDir(rootDir), { recursive: true });
    writeJsonFile(proposalFilePath(rootDir, doc.proposalId), doc);

    appendAuditEvent(rootDir, campaignId, {
      event: "memory_proposal_recorded",
      proposalId: doc.proposalId,
      agentId: doc.agentId,
      taskId
    });

    stored.push(doc);
  });

  return { stored, rejected };
}

/**
 * @param {string} rootDir
 * @param {{ status?: string }} [options]
 * @returns {object[]} proposal documents sorted by proposalId, optionally
 *   filtered by status.
 */
export function listProposals(rootDir, { status } = {}) {
  const dir = proposalsDir(rootDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const docs = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonFile(path.join(dir, name)));

  const filtered = status ? docs.filter((doc) => doc.status === status) : docs;
  return filtered.sort((a, b) => (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0));
}

/**
 * @param {string} rootDir
 * @param {string} proposalId
 * @returns {object|null}
 */
export function loadProposal(rootDir, proposalId) {
  const filePath = proposalFilePath(rootDir, proposalId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJsonFile(filePath);
}

function requireNonEmptyFinalContent(finalContent) {
  if (typeof finalContent !== "string" || finalContent.trim().length === 0) {
    throw new Error("edit_and_approve requires a non-empty finalContent");
  }
}

/**
 * Applies a manager decision to a pending proposal. `decidedBy` is required
 * — this is the governance gate that keeps memory writes tied to an actual
 * decision-maker. Only `approve`/`edit_and_approve` result in a memory
 * write (via `appendMemoryEntry`); `reject`/`escalate` persist the status
 * change only, keeping the proposal on disk for audit.
 *
 * @param {string} rootDir
 * @param {string} proposalId
 * @param {{ action: "approve"|"edit_and_approve"|"reject"|"escalate", finalContent?: string, reason?: string }} decision
 * @param {{ campaignId?: string, decidedBy: string }} [options]
 * @returns {{ proposal: object, entry: object|null }}
 */
export function applyDecision(rootDir, proposalId, decision, { campaignId, decidedBy } = {}) {
  if (!decidedBy) {
    throw new Error("applyDecision requires decidedBy");
  }

  const proposal = loadProposal(rootDir, proposalId);
  if (!proposal) {
    throw new Error(`Proposal ${proposalId} not found`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`Proposal ${proposalId} is not pending (status: ${proposal.status})`);
  }

  const action = decision?.action;
  let status;
  let finalContent = null;

  switch (action) {
    case "approve":
      status = "approved";
      finalContent = proposal.content;
      break;
    case "edit_and_approve":
      requireNonEmptyFinalContent(decision?.finalContent);
      status = "edited";
      finalContent = decision.finalContent;
      break;
    case "reject":
      status = "rejected";
      break;
    case "escalate":
      status = "escalated";
      break;
    default:
      throw new Error(`Unknown memory decision action: ${action}`);
  }

  // Perform the memory write (if any) BEFORE persisting the new proposal
  // status. `appendMemoryEntry` validates the namespace itself and throws
  // before touching disk if it's malformed, so a bad scope surfaces as a
  // thrown error here and the proposal file below is never written --
  // it stays "pending" on disk rather than getting stuck "approved"/"edited"
  // with no corresponding memory entry.
  let entry = null;
  if (status === "approved" || status === "edited") {
    entry = appendMemoryEntry(rootDir, proposal.scope, {
      content: finalContent,
      type: proposal.type,
      sourceProposalId: proposal.proposalId,
      agentId: proposal.agentId
    });
  }

  const decidedAt = new Date().toISOString();
  const updated = {
    ...proposal,
    status,
    decidedBy,
    decidedAt,
    ...(finalContent !== null ? { finalContent } : {})
  };
  writeJsonFile(proposalFilePath(rootDir, proposalId), updated);

  const effectiveCampaignId = campaignId ?? proposal.campaignId;
  appendAuditEvent(rootDir, effectiveCampaignId, {
    event: "memory_decision",
    proposalId,
    action,
    decidedBy
  });

  return { proposal: updated, entry };
}
