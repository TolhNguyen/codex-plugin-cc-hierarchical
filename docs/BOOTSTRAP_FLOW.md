# Bootstrap Flow

Source of truth: `plugins/codex/scripts/orchestration-cli.mjs`,
`plugins/codex/commands/bootstrap-agents.md`,
`plugins/codex/commands/campaign.md`,
`plugins/codex/scripts/orchestration/{repository-analyzer,topology-planner,
campaign-orchestrator,review-loop,budget,audit-log}.mjs`,
`plugins/codex/scripts/memory/memory-review.mjs`. See also `AGENT_MODEL.md`,
`SKILL_MODEL.md`, `MEMORY_GOVERNANCE.md`, `WORKER_RUNTIME.md` for the
mechanics behind each stage below.

## 1. End-to-end diagram

```text
 /codex:bootstrap-agents
        │
        ▼
 repository-analyzer.mjs (deterministic, no LLM)
        │  -> .ai-company/project-profile.json
        ▼
 topology-planner.mjs: proposeTopology()  (1 Codex turn, schema-constrained,
        │                                  retry-once on invalid output)
        │  -> .ai-company/topology-proposal.json  (DRAFT — nothing active)
        ▼
 rendered report to the Executive (topology type, agents, skill drafts,
        │  overlaps, risks) — "Nothing has been activated."
        ▼
 human/Executive approval  ( --approve --approved-by <role> )
        │
        ▼
 topology-planner.mjs: approveTopology()
        │  -> agents saved status=proposed, then setAgentStatus(...,"active")
        │     with an approval record  { role, decision, at }
        │  -> skills saved status=draft (still NOT usable by any worker yet)
        ▼
 [out of MVP CLI scope: manual skill evaluation]
        │  setSkillStatus(draft->evaluating->approved->active), each gated
        │  transition stamps approvedBy
        ▼
 /codex:campaign create --brief <text> --criteria <text>...
        │  -> .ai-company/campaigns/<id>/campaign.json  (status: draft)
        ▼
 /codex:campaign approve <id> --approved-by <role>
        │  draft -> awaiting_approval -> running   (approval record required)
        ▼
 /codex:campaign run-task <id> --task-file <task.json>
        │
        ▼
 runCampaignTask: routeTask -> bounded review loop (budget-guarded)  ──┐
        │  worker.execute (attempt N)                                 │
        │  ├─ transport failure -> synthesized rework/escalate         │  loop:
        │  └─ completed -> manager review turn (schema-constrained,    │  attempt
        │       retry-once) -> approve|rework|split|reassign|escalate  │  1..N
        │  rework -> attempt N+1 with feedback injected (N < maxAttempts) │
        │  every step -> audit.log (JSONL, append-only)               ─┘
        │
        ├─ approved  -> task-result.memoryProposals -> recordProposals()
        │                -> .ai-company/memory/proposals/<id>.json (pending)
        ├─ escalated -> surfaced in the CLI report / campaign paused if budget
        └─ halted    -> campaign auto-paused (budget or wall-clock exhausted)
        ▼
 /codex:campaign review-proposals <id> --decided-by <role>
        │  manager decision turn per pending proposal (schema-constrained,
        │  retry-once) -> applyDecision() -> approve/edit_and_approve writes
        │  a new memory-store version; reject/escalate keep the proposal
        │  (status changed, no memory write) for audit
        ▼
 /codex:campaign accept <id> --accepted-by <role>
        │  running/paused -> completed  (Executive sign-off; closes the
        │  campaign — no further approval semantics beyond this)
        ▼
 done
```

## 2. Stage detail

### 2.1 Repository analysis (`repository-analyzer.mjs`)

Deterministic, no LLM, no network — a single breadth-first filesystem walk
(depth-capped at 6, file-capped at 5000, symlinks skipped, `node_modules`/
`.git`/`.ai-company`/etc. ignored) feeds every detector. What it produces,
concretely:

- **languages** — by file extension, only kept if ≥ 3 files of that
  extension exist (else falls back to the single most frequent extension).
- **frameworks** — from `package.json` `dependencies`/`devDependencies`
  matched against a fixed dependency→framework table (react, next, vue,
  express, fastify, nest, jest, vitest, typescript).
- **commands** (`test`/`build`/`lint`) — from `package.json#scripts`, or
  (no `package.json`) from a `Makefile`'s `test:`/`build:`/`lint:` targets.
- **structure** — sorted top-level directory names; up to 10 entry-point
  candidates (`package.json#main`/`#bin`, `index.mjs`/`index.js`,
  `src/index.*`, and any `scripts/*.mjs` with a `#!` shebang, size-guarded
  at 256 KiB before being read).
- **testLayout** — dominant test directory + dominant naming pattern
  (`*.test.*`/`*.spec.*`/`test_*.py`) + inferred runner from the test
  command string (`node:test`/`jest`/`vitest`/`pytest`/first token of the
  command). Omitted entirely if no test files are found.
- **ci** — `.github/workflows/*.y*ml` file list, provider fixed to
  `"github-actions"` (no other CI provider is detected). Omitted if none.
- **docs** — root doc files (`README.md`/`CONTRIBUTING.md`/`CLAUDE.md`/
  `AGENTS.md`) plus everything under `docs/**/*.md`, capped at 25.
- **capabilities.technical** — flags derived from source-content regex
  scans over the first 200 source files by path, size-guarded at 256 KiB
  each: `nodejs` (a `package.json` exists), `typescript` (`tsconfig*` or any
  `.ts`/`.mts` file), `background-jobs` (`spawn`/`worker_threads`/
  `child_process` literal), `socket-communication` (`net.createServer`/
  `net.createConnection`/`WebSocket`), `http-api`
  (`createServer`/`express()`/`fastify()`/`listen(<port>`),
  `structured-state` (any `*.schema.json` file or a `schemas/` directory).
- **capabilities.domains** — top-level or `src/<name>` directories matching
  a small fixed word list (`auth`, `billing`, `orders`, `payments`,
  `inventory`, `users`, `accounts`) — this is a coarse heuristic, not
  semantic analysis.
- **capabilities.crossCutting** — `testing` if a test layout was found,
  `ci` if CI was found, `concurrency` if background-jobs or
  socket-communication flags are set.

Output is validated against `project-profile.schema.json` and written to
`.ai-company/project-profile.json` (`writeProjectProfile`); `bootstrap
--profile-only` stops here.

### 2.2 Topology proposal (`topology-planner.mjs`)

One Codex (manager) turn, `sandbox: "read-only"`, `outputSchema:
topology-proposal.schema.json`. The prompt
(`prompts/orchestration/topology-proposal.md`) embeds the full project
profile and a fixed rule set (no utility-shaped agents; persistent only if
it meets all four ownership/recurrence/verifiability/scope conditions;
merge agents with identical skills+permissions; prefer one persistent agent
for small repos; minimal-scope permissions; tiered, shareable skill ids —
see `AGENT_MODEL.md` §5 for the full anti-pattern list). On a schema
validation failure, `proposeTopology` retries **exactly once** with a
correction prompt listing the validation errors
(`buildCorrectionPrompt`); a second failure throws. The result is written,
unvalidated-by-anyone-else, to `.ai-company/topology-proposal.json`
(`writeTopologyProposal`, itself re-validating before writing).

### 2.3 Human/Executive approval

`/codex:bootstrap-agents` (the command markdown, not the CLI) enforces the
approval gate at the **Claude session** level: it never calls
`approve-topology` unless the raw slash-command arguments *literally*
contain `--approve`, and never fabricates or defaults `--approved-by` — it
must `AskUserQuestion` for a role/name if one wasn't given. This is a
prompt-level rule enforced by the command's own instructions, not something
the CLI itself can be trusted to gate (the CLI's `approve-topology`
subcommand will happily run for any caller that supplies `--approved-by`).
"Nothing is activated automatically" is the literal report line rendered by
`renderBootstrapReport`.

`node orchestration-cli.mjs approve-topology --approved-by <role>`:

- for every `skillDraft`: builds a full skill document (defaulting
  `version: "0.1.0"`, `status: "draft"`, and filling any schema-required
  array field the draft omitted with `[]`/a placeholder) and `saveSkill`s
  it — **skills stay `draft`**, not usable by any worker yet
  (`SKILL_MODEL.md` §5);
- for every proposed agent: builds the full agent document
  (`type: persistent|temporary`, resolving each `skills` ref to
  `id@0.1.0` if it matches a just-created draft id, else leaving/appending
  the version as-is), `saveAgent`s it as `status: "proposed"`, then
  immediately `setAgentStatus(..., "active", { role: approvedBy, decision:
  "approve", at })` in the same call — so in this flow "proposed" is a
  same-call transient state, not a second waiting room.

### 2.4 Skill evaluation (manual, outside the shipped CLI)

There is no `/codex:skills` command or CLI subcommand for this in the MVP
(deferred per `docs/TARGET_ARCHITECTURE.md` §2). Driving a skill from
`draft` to `active` means calling `setSkillStatus` directly through the
registry module (or a short ad-hoc script) three times, in order —
`draft->evaluating` (no approval needed), `evaluating->approved`
(`approvedBy` required), `approved->active` (`approvedBy` required again)
— interspersed with whatever evaluation-task evidence your process wants
recorded via `recordEvaluation(rootDir, skillId, { taskId, outcome, at })`.
A task cannot route to (`task-router.mjs` step 8) or be executed by
(`buildWorkerContext`'s `assertSkillsActive`) a worker requiring a skill
that hasn't completed this chain.

### 2.5 Campaign lifecycle (`/codex:campaign`)

All subcommands are 1:1 thin forwards to `orchestration-cli.mjs campaign
<action>` — the command markdown never edits `.ai-company/**` itself and
never invents data the CLI didn't return; it always shows the CLI's raw
stdout first, then adds its own summary. Exact invocations
(`orchestration-cli.mjs`'s `printUsage`):

```text
node scripts/orchestration-cli.mjs bootstrap [--cwd <path>] [--profile-only] [--json]
node scripts/orchestration-cli.mjs approve-topology --approved-by <role> [--cwd <path>] [--json]
node scripts/orchestration-cli.mjs campaign create --brief <text> [--criteria <text>]...
    [--max-executive-calls N] [--max-manager-calls N] [--max-worker-calls N]
    [--max-attempts-per-task N] [--max-campaign-duration-minutes N] [--cwd <path>] [--json]
node scripts/orchestration-cli.mjs campaign list [--cwd <path>] [--json]
node scripts/orchestration-cli.mjs campaign show <campaignId> [--cwd <path>] [--json]
node scripts/orchestration-cli.mjs campaign run-task <campaignId> --task-file <path.json>
    [--manager-agent <id>] [--cwd <path>] [--json]
node scripts/orchestration-cli.mjs campaign approve --approved-by <role> <campaignId> [--cwd <path>] [--json]
node scripts/orchestration-cli.mjs campaign review-proposals <campaignId> --decided-by <role> [--cwd <path>] [--json]
node scripts/orchestration-cli.mjs campaign accept <campaignId> --accepted-by <role> [--cwd <path>] [--json]
```

Status transitions (`CAMPAIGN_STATUS_TRANSITIONS` in
`campaign-orchestrator.mjs`):

```text
draft -> awaiting_approval -> running -> {paused, completed, failed, cancelled}
                                paused -> {running, cancelled, failed}
```

`campaign approve` drives `draft -> awaiting_approval` automatically (if
still `draft`) and then `awaiting_approval -> running`, appending an
`{ role, decision: "approve", at }` record — this is the one status
transition that requires an approval object; `setCampaignStatus` throws
without one. `campaign create` seeds `budget` from `DEFAULT_BUDGET`
(`maxExecutiveCalls: 5, maxManagerCalls: 30, maxWorkerCalls: 60,
maxAttemptsPerTask: 3, maxCampaignDurationMinutes: 180`) overridden
field-by-field by any `--max-*` flags given.

The `campaign.md` command additionally layers Executive-side confirmation
rules on top of the CLI (never inferred from tone, always `AskUserQuestion`
if a required role/name is missing) for `approve`, `accept`, and
`review-proposals` specifically — `run-task` does not itself require a
confirmation gate to invoke, but the command instructs checking
`campaign show` first and not running a task against a non-`running`
campaign.

### 2.6 The bounded review loop (`review-loop.mjs`, `campaign-orchestrator.mjs`)

One task, `runCampaignTask`: `routeTask` (`AGENT_MODEL.md` §7) picks the
owner and logs any `writeGaps`; a fresh `createBudget(campaign)` guard set
and a fresh worker/manager runtime pair are constructed per call
(`workerRuntimeFactory`/`managerRuntimeFactory`, both injectable for tests).
`runReviewLoop` then iterates attempts `1..maxAttempts`
(`maxAttempts = min(task.maxAttempts, agent.limits.maxAttemptsPerTask)`,
floored at 1):

1. `guards.beforeWorkerCall` — a budget-guard throw here halts the loop
   *before* spending a worker call, audited as `loop_halted`.
2. `workerRuntime.execute(agent, buildWorkerContext(...))` — a thrown
   exception here (a caller bug, per `WORKER_RUNTIME.md` §5) also halts the
   loop; a returned non-`"completed"` `RuntimeResult` does **not** consult
   the manager — `synthesizeTransportDecision` produces `rework` (if
   attempts remain) or `escalate` (if not) locally, so a transport failure
   never spends manager budget.
3. On a `"completed"` worker result: `guards.beforeManagerCall`, then
   `createCodexReviewer`'s `reviewFn` — one Codex turn with
   `outputSchema: review-decision.schema.json`, one schema-repair retry on
   invalid output, then throw (caught and turned into `"halted"` with a
   `review_failed` + `loop_halted` audit pair).
4. The decision (`approve`/`rework`/`split`/`reassign`/`escalate`) is
   appended to the task's `attempts` log and the task document is
   persisted (`.ai-company/campaigns/<id>/tasks/<taskId>.json`) with a
   status derived by `mapDecisionToTaskStatus`. `approve` ends the loop;
   `rework` carries `decision.feedback` into the next attempt's worker
   context; `split`/`reassign`/`escalate` end the loop immediately (the
   orchestrator/Executive handles what happens next — the loop itself does
   not re-route or re-split anything).
5. Exhausting all attempts while still getting `rework` synthesizes an
   `escalate` decision (`synthesizeExhaustedDecision`,
   code `MAX_ATTEMPTS_EXHAUSTED`) rather than looping forever — this is the
   only place attempts run out without an explicit manager escalate call.

Every step above appends one line to
`.ai-company/campaigns/<id>/audit.log` via `appendAuditEvent` — this is a
plain JSONL file, one compact JSON object per line, corrupt lines skipped
on read, never rewritten or truncated.

If the loop outcome is `"halted"` (a budget or wall-clock guard fired),
`runCampaignTask` tries `setCampaignStatus(..., "paused")` (swallowing the
error if the campaign wasn't in a state from which `paused` is legal) and
appends a `campaign_paused_budget` audit event — this never throws out of
`runCampaignTask` itself.

### 2.7 Memory proposals

If the loop's final worker result parses as JSON with a non-empty
`memoryProposals` array, `runCampaignTask` calls `recordProposals` (one
call per task run, not per attempt) — see `MEMORY_GOVERNANCE.md` for the
full proposal → decision → memory-entry flow and the three independent
enforcement layers behind it.

### 2.8 Acceptance

`/codex:campaign accept <id> --accepted-by <role>` calls
`setCampaignStatus(rootDir, id, "completed")` (from `running` *or*
`paused` — both are legal `-> completed` per `CAMPAIGN_STATUS_TRANSITIONS`)
and appends a `campaign_accepted` audit event. This is the terminal,
Executive-only sign-off step; there is no further status transition out of
`completed`.

## 3. What's deliberately out of scope for the shipped bootstrap flow

Per `docs/MVP_PLAN.md` §1: no vector DB, no self-editing prompts/skills/
memory, no multi-manager, no worker parallelism, no auto-merge, no auto
agent creation beyond the one topology-approval path above, no
model-graded-only evals, no `agents.md`/`skills.md`/`memory.md`/
`proposals.md` commands (their functionality lives in the registries/CLI
subcommands documented above, just without a dedicated slash command yet).
