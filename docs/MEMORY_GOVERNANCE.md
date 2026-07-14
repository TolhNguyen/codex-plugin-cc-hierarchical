# Memory Governance

Source of truth: `plugins/codex/scripts/memory/memory-store.mjs`,
`plugins/codex/scripts/memory/proposal-store.mjs`,
`plugins/codex/scripts/memory/memory-review.mjs`,
`plugins/codex/scripts/agents/permission-guard.mjs`,
`plugins/codex/schemas/orchestration/memory-proposal.schema.json`,
`plugins/codex/schemas/orchestration/memory-decision.schema.json`. See also
`AGENT_MODEL.md` §2 (`memory.namespaces`) and `SKILL_MODEL.md` §6 (memory vs.
skill vs. context vs. task).

## 1. The three enforcement layers

Memory governance is not one gate, it is three independent, redundant ones —
each would be sufficient alone; together they mean there is no single
mistake that turns a worker-controlled string into a durable memory entry.

1. **Path-level: `.ai-company/**` is always write-denied.**
   `permission-guard.mjs`'s `ALWAYS_WRITE_DENIED_GLOBS` includes
   `.ai-company` and `.ai-company/**` unconditionally — `canWrite`/
   `assertWrite` deny it *before* even consulting the agent's own
   `permissions.write` list. Since all memory (and all agent/skill/campaign
   state) lives under `.ai-company/`, a worker's `write_file` tool call can
   never reach a memory file, no matter what its `permissions.write` globs
   say.
2. **Proposals are the only worker-visible path.** A worker never calls
   `appendMemoryEntry` — it isn't exposed as a tool at all (§5 of
   `WORKER_RUNTIME.md` lists the only five tools; none of them is a memory
   write). The *only* way a worker's opinion about durable memory reaches
   disk is by putting objects in `task-result.memoryProposals`, which
   `campaign-orchestrator.mjs`'s `runCampaignTask` reads and hands to
   `recordProposals` — and `recordProposals` produces `status: "pending"`
   documents in `.ai-company/memory/proposals/`, not memory entries.
3. **`applyDecision` requires `decidedBy`.** `applyDecision` is the *only*
   function that can call `appendMemoryEntry` (`memory-store.mjs`'s doc
   comment calls it out explicitly: "the ONLY write path for official
   memory"). It throws `applyDecision requires decidedBy` if that option is
   missing — there is no anonymous or default decider. `decidedBy` is a
   free-form string (a role name, e.g. `"engineering-lead"`), supplied by
   whoever invokes `campaign review-proposals --decided-by <role>` or calls
   `reviewPendingProposals` directly.

Note what is **not** an enforcement layer here: `recordProposals` also
strips and re-derives `proposalId`, `agentId`, and `status` server-side from
its own call arguments — a worker-supplied `task-result.memoryProposals[i]`
object contributes only `scope`, `content`, `type`, `evidence`, `confidence`;
any other fields it includes are simply discarded (not an error, just
ignored) since `recordProposals` builds the candidate object field-by-field
rather than spreading the raw input.

## 2. Proposal lifecycle

```text
pending --(applyDecision: approve)-------> approved   (memory entry written)
pending --(applyDecision: edit_and_approve)-> edited   (memory entry written, content = finalContent)
pending --(applyDecision: reject)---------> rejected   (no memory entry; kept on disk)
pending --(applyDecision: escalate)-------> escalated  (no memory entry; kept on disk)
```

- `applyDecision` throws if the proposal is not currently `pending` — a
  decision can only ever be applied once (`Proposal <id> is not pending
  (status: <status>)`).
- `approve` writes `finalContent = proposal.content` unchanged.
  `edit_and_approve` requires a non-empty `decision.finalContent`
  (`requireNonEmptyFinalContent` throws `edit_and_approve requires a
  non-empty finalContent` otherwise) and uses that instead.
- **Order of operations matters**: the memory write (if any) happens
  *before* the proposal file is rewritten with its new status. If
  `appendMemoryEntry` throws (e.g. the proposal's `scope` somehow became an
  invalid namespace after recording — see §3), the proposal file is never
  rewritten and stays `pending` on disk, rather than ending up `approved`/
  `edited` with no corresponding memory entry. A caller sees the thrown
  error and can retry or escalate manually.
- **Rejected and escalated proposals are kept, never deleted** — this is
  the audit trail for governance decisions that did *not* result in a
  memory write, not just the ones that did. `listProposals(rootDir, {
  status })` can list any status, including these.
- Every recorded proposal and every applied decision appends one line to
  the campaign's audit log (`memory_proposal_recorded`, `memory_decision` —
  see `docs/MVP_PLAN.md`/`audit-log.mjs`).

## 3. Namespace → file mapping and the validation rule

`memory-store.mjs`'s `NAMESPACE_RE` is
`^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9._-]*)+$` — lowercase-alnum-hyphen
first segment, one or more `/`-separated further segments, each
lowercase-alnum plus `.`/`_`/`-`. No `..`, no absolute paths, no
backslashes can match, so the regex doubles as a **path-traversal guard**:
`namespaceToPath` cannot be tricked into escaping the memory directory.

| Namespace shape | File |
|---|---|
| `agent/<id>` | `.ai-company/memory/agents/<id>.json` |
| `domain/<name>` | `.ai-company/memory/domains/<name>.json` |
| anything else, e.g. `project/shared` | `.ai-company/memory/shared/<slug>.json`, where `slug` = namespace with every `/` replaced by `__` (so `project/shared` → `shared/project__shared.json`) |

**Scope is validated at record time, not just at write time.**
`recordProposals` calls `isValidNamespace(candidate.scope)` itself (a
predicate twin of the internal `assertValidNamespace` used by
`namespaceToPath`) and routes a malformed scope into the `rejected` array
(`Invalid memory namespace: <scope>`) — it never throws, because one bad
proposal must never fail the worker's whole task result. This means a
malformed scope is caught *before* the proposal is even persisted as
`pending`, not only later when `applyDecision` would eventually call
`appendMemoryEntry` (which re-validates too, since `namespaceToPath` always
asserts). Two independent checks, same regex, same rule — belt and
suspenders around the one thing that decides which file on disk a decision
can affect.

## 4. How memory is injected into worker context

`buildWorkerContext` (`campaign-orchestrator.mjs`) is the only place a
worker's context is assembled, and the only memory it includes is:

```js
listMemoryEntries(rootDir, agent?.memory?.namespaces ?? [])
```

— i.e., **only the namespaces the owning agent's document explicitly
lists** (`AGENT_MODEL.md` §2). `listMemoryEntries` reads each namespace file
in the order given, flattens entries (each annotated with its source
`namespace`), and skips namespaces that don't resolve or don't exist yet
(missing file → empty entries, not an error). There is no cross-namespace
leakage: an agent granted `["agent/test-and-verification-worker-01",
"project/shared"]` never sees `domain/billing` memory even if it exists.

`renderMemoryForPrompt(entries, { maxEntries = 20, maxChars = 4000 })`
formats the flattened list into the system prompt's `## Memory` block:
drops the oldest entries first once over `maxEntries`, then keeps trimming
from the front until the joined text fits `maxChars`, appending an
`"... (N more entries omitted)"` line if anything was dropped. With no
entries at all it renders the literal string `(no memory entries)`.

## 5. The manager decision flow (`reviewPendingProposals`)

`memory-review.mjs` deliberately separates **deciding** from **mutating**:

- `createMemoryReviewer({ rootDir, runtime, managerAgent })` returns a
  `decide(proposal, { taskContext, memoryEntries })` function. It builds
  the `orchestration/memory-decision` prompt (proposal JSON + task context +
  existing memory for the proposal's own scope, rendered via
  `renderMemoryForPrompt`), runs one Codex manager turn with
  `outputSchema: memory-decision.schema.json`, and on a validation failure
  does exactly **one** schema-repair retry (mirrors
  `review-loop.mjs`'s `createCodexReviewer`) before throwing. `decide`
  itself never calls `applyDecision` — it only returns the decided action.
- `reviewPendingProposals(rootDir, { campaignId, decide, decidedBy, guards
  })` drives `decide` over every currently-`pending` proposal (in
  `proposalId` order) and is the function that actually calls
  `applyDecision` for each one. Behavior per proposal:
  - `guards.beforeManagerCall` is awaited before each `decide` call (the
    same budget-guard-before-every-manager-call pattern as the review
    loop); if it throws, the batch stops immediately and returns
    `{ processed, halted: true }` with whatever was already processed.
  - a failure from `decide` or `applyDecision` for **one** proposal (e.g. a
    scope that somehow became invalid between recording and review) is
    recorded as `{ proposalId, action: "failed", error }` in `processed`
    and does **not** abort the batch — every other pending proposal still
    gets a chance.
- The manager's decision (`memory-decision.schema.json`) is one of
  `approve` / `edit_and_approve` / `reject` / `escalate`, each requiring a
  free-text `reason`; `edit_and_approve` additionally requires
  `finalContent`. The decision-rules prompt
  (`prompts/orchestration/memory-decision.md`) instructs the manager to
  `escalate` rather than decide unilaterally whenever approving a proposal
  would effectively change a business rule, ownership boundary, or policy —
  that judgment call is prompt-level guidance, not a code-enforced rule.
- `handleCampaignReviewProposals` in `orchestration-cli.mjs`
  (`/codex:campaign review-proposals <id> --decided-by <role>`) is the CLI
  entry point: it builds a real `CodexRuntime`, wires
  `budget.guards.beforeManagerCall` from the campaign's own budget, runs
  `reviewPendingProposals`, then persists the campaign (usage counters were
  mutated in place by the guard) regardless of outcome.
