import fs from "node:fs";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "../lib/fs.mjs";
import { generateJobId } from "../lib/state.mjs";

/**
 * File-based memory store. This is the ONLY write path for official memory:
 * workers never touch these files directly (permission-guard always denies
 * writes to `.ai-company/**`); the only way an entry lands here is through
 * `appendMemoryEntry`, which is called exclusively by `applyDecision` in
 * `proposal-store.mjs` on an approved/edited governance decision.
 *
 * Namespace -> file path mapping:
 *   agent/<id>    -> .ai-company/memory/agents/<id>.json
 *   domain/<name> -> .ai-company/memory/domains/<name>.json
 *   anything else -> .ai-company/memory/shared/<slug>.json
 *     (slug = namespace with "/" replaced by "__", e.g. "project__shared")
 */

const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9._-]*)+$/;

/**
 * Predicate form of the namespace format check, for callers that need to
 * validate (and reject gracefully) without relying on a thrown exception —
 * e.g. `recordProposals`, which must never throw on worker-supplied input.
 * Same regex, same rules as `assertValidNamespace`; does not change behavior.
 *
 * @param {unknown} namespace
 * @returns {boolean}
 */
export function isValidNamespace(namespace) {
  return typeof namespace === "string" && NAMESPACE_RE.test(namespace);
}

function assertValidNamespace(namespace) {
  if (!isValidNamespace(namespace)) {
    throw new Error(`Invalid memory namespace: ${namespace}`);
  }
}

function memoryDir(rootDir) {
  return path.join(rootDir, ".ai-company", "memory");
}

/**
 * Resolves a validated namespace to its on-disk file path. Also serves as a
 * path-traversal guard: the namespace pattern forbids "..", absolute paths,
 * and backslashes, so no caller-supplied namespace can escape the memory
 * directory.
 */
export function namespaceToPath(rootDir, namespace) {
  assertValidNamespace(namespace);
  const parts = namespace.split("/");

  if (parts[0] === "agent" && parts.length === 2) {
    return path.join(memoryDir(rootDir), "agents", `${parts[1]}.json`);
  }

  if (parts[0] === "domain" && parts.length === 2) {
    return path.join(memoryDir(rootDir), "domains", `${parts[1]}.json`);
  }

  const slug = namespace.split("/").join("__");
  return path.join(memoryDir(rootDir), "shared", `${slug}.json`);
}

/**
 * @param {string} rootDir
 * @param {string} namespace
 * @returns {{ namespace: string, version: number, entries: object[] }}
 */
export function readMemory(rootDir, namespace) {
  const filePath = namespaceToPath(rootDir, namespace);
  if (!fs.existsSync(filePath)) {
    return { namespace, version: 0, entries: [] };
  }
  return readJsonFile(filePath);
}

/**
 * Flattens memory entries across the given namespaces, in the order the
 * namespaces were given and in stored order within each namespace. Each
 * entry is annotated with its source `namespace`. Namespaces with no memory
 * yet (or that fail to resolve) are skipped rather than throwing.
 *
 * @param {string} rootDir
 * @param {string[]} namespaces
 * @returns {object[]}
 */
export function listMemoryEntries(rootDir, namespaces) {
  const list = Array.isArray(namespaces) ? namespaces : [];
  const out = [];

  for (const namespace of list) {
    if (!namespace) {
      continue;
    }

    let doc;
    try {
      doc = readMemory(rootDir, namespace);
    } catch {
      continue;
    }

    for (const entry of doc.entries ?? []) {
      out.push({ ...entry, namespace });
    }
  }

  return out;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Memory entry requires a non-empty "${field}"`);
  }
}

/**
 * The ONLY write path for official memory. Assigns `entryId`/`createdAt`,
 * bumps the document `version`, and persists it.
 *
 * @param {string} rootDir
 * @param {string} namespace
 * @param {{ content: string, type: string, sourceProposalId: string, agentId: string, supersedes?: string }} entry
 * @returns {object} the stored entry
 */
export function appendMemoryEntry(rootDir, namespace, entry) {
  requireNonEmptyString(entry?.content, "content");
  requireNonEmptyString(entry?.type, "type");
  requireNonEmptyString(entry?.sourceProposalId, "sourceProposalId");
  requireNonEmptyString(entry?.agentId, "agentId");

  const filePath = namespaceToPath(rootDir, namespace);
  const current = readMemory(rootDir, namespace);

  const stored = {
    entryId: generateJobId("mem"),
    content: entry.content,
    type: entry.type,
    sourceProposalId: entry.sourceProposalId,
    agentId: entry.agentId,
    createdAt: new Date().toISOString(),
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {})
  };

  const nextDoc = {
    namespace,
    version: (current.version ?? 0) + 1,
    entries: [...(current.entries ?? []), stored]
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonFile(filePath, nextDoc);

  return stored;
}

/**
 * Renders memory entries into a compact text block for prompt injection.
 * Truncates by count then by total character budget, dropping the oldest
 * entries first, appending an omission line when anything was dropped.
 *
 * @param {object[]} entries
 * @param {{ maxEntries?: number, maxChars?: number }} [options]
 * @returns {string}
 */
export function renderMemoryForPrompt(entries, { maxEntries = 20, maxChars = 4000 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    return "(no memory entries)";
  }

  let omitted = 0;
  let selected = list;
  if (selected.length > maxEntries) {
    omitted += selected.length - maxEntries;
    selected = selected.slice(-maxEntries);
  }

  const lines = selected.map((entry) => `- [${entry.namespace}/${entry.type}] ${entry.content}`);

  while (lines.length > 0 && lines.join("\n").length > maxChars) {
    lines.shift();
    omitted += 1;
  }

  if (omitted > 0) {
    lines.push(`... (${omitted} more entries omitted)`);
  }

  return lines.join("\n");
}
