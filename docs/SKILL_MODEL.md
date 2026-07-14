# Skill Model

Source of truth: `plugins/codex/schemas/orchestration/skill.schema.json`,
`plugins/codex/scripts/skills/skill-registry.mjs`,
`plugins/codex/scripts/orchestration/task-router.mjs`,
`plugins/codex/scripts/orchestration/campaign-orchestrator.mjs`
(`buildWorkerContext`/`renderSkillBlock`). See also `AGENT_MODEL.md` (who
gets granted a skill) and `BOOTSTRAP_FLOW.md` (where skill drafts come
from).

## 1. What a skill IS

A skill is a versioned, reusable **procedure document** — not code, not a
prompt template file, not a capability flag. It is a JSON file at
`.ai-company/skills/<tier>/<name>.json`, where the skill's `id` is always
the literal string `<tier>/<name>` (parsed by `parseSkillId` in
`skill-registry.mjs`; malformed ids without exactly one `/` throw). Agents
reference skills by a **pinned ref** `tier/name@x.y.z`
(`loadSkillByRef` splits on the last `@`); an agent's `skills` array can
name a skill version that doesn't match the currently-stored version, which
resolves to "not found" — pins are exact-match, not semver ranges.

## 2. Tiers

The tier is the first path segment and is part of the id's regex
(`^(core|technical|project|domain)/[a-z0-9-]+$`):

| Tier | Meaning | Example |
|---|---|---|
| `core` | Baseline behavior every worker needs regardless of domain (task execution discipline, scope control, structured reporting, self-verification, escalation). Per `docs/MVP_PLAN.md` §2, these are meant to ship as static plugin content copied into `.ai-company/` at bootstrap. | `core/task-execution` |
| `technical` | A cross-project technical practice, shareable across repos/agents doing the same *kind* of work. | `technical/node-test-authoring` |
| `project` | A convention specific to this one repository. | `project/codex-plugin-test-conventions` |
| `domain` | A business-domain rule (e.g. billing, auth) — not exercised by the MVP's single test-and-verification worker, but part of the schema/id grammar. | `domain/billing-invoicing` |

**Divergence from `MVP_PLAN.md`**: the plan states core skills "ship as
static plugin content in `plugins/codex/skills-orchestration/core/` and are
copied into `.ai-company/` at bootstrap." As committed, no such directory
exists and neither `topology-planner.mjs` nor `orchestration-cli.mjs`
contains any copy step — `approveTopology` only ever registers
`skillDrafts` that came back from the Codex-backed proposal (all normalized
to `status: "draft"`, `version: "0.1.0"`). If your topology references a
`core/*` skill, you must author and register it yourself (see
`.ai-company.example/skills/core/task-execution.json` for a worked
example) before any agent that requires it can be routed to.

## 3. Field-by-field (`skill.schema.json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string, `^(core\|technical\|project\|domain)/[a-z0-9-]+$` | yes | Determines the on-disk path. |
| `version` | string, `^\d+\.\d+\.\d+$` | yes | Exact-match only; no range resolution anywhere in the codebase. |
| `status` | `draft`\|`evaluating`\|`approved`\|`active`\|`deprecated` | yes | Registry-enforced state machine, §4. |
| `purpose` | string | yes | One-line "what is this for." |
| `useWhen` | string[] | yes | Situations where this skill applies. |
| `dontUseWhen` | string[] | yes | Explicit non-applicability — keeps a worker from over-generalizing a skill. |
| `requiredInputs` | string[] | yes | What context the worker needs before it can execute the procedure. |
| `procedure` | string[], min 1 | yes | The actual numbered steps; rendered as a `1. 2. 3.` list in the worker system prompt (`renderSkillBlock`). |
| `verificationSteps` | string[] | yes | How the worker proves it did the thing (feeds `task-result.verification`). |
| `doneWhen` | string[] | yes | Completion criteria. |
| `escalateWhen` | string[] | yes | When the worker should emit `status: "escalate"` in its task-result instead of pushing through. |
| `outputContract` | string | yes | Free-text pointer to the expected output shape (MVP skills all use the literal string `"task-result"`). |
| `sources` | string[] | yes | Where this skill was grounded (files/commands in the repo) — required even in a bare draft (`topology-proposal.schema.json` requires it on every `skillDraft` too). |
| `owner` | string | yes | The role/agent id accountable for the skill's content (MVP skills use `"manager-codex"`). |
| `requires` | string[] | no | Other skill refs this one depends on. Declared in the schema; not read/enforced anywhere in the shipped code (no code checks that a required skill is present or active). |
| `approvedBy` | string | no (required by transition, not by schema) | Stamped by `setSkillStatus` on gated transitions (§4); persisted on the document once set. |
| `evaluations` | array of `{ taskId, outcome, at }` | no | Appended by `recordEvaluation` — one entry per evaluation task run against the skill. |
| `permissionsNeeded.read` / `.write` | string[] | no | Declared file-scope the skill implies; informational — not cross-checked against an agent's actual `permissions` anywhere in the shipped code. |

## 4. Lifecycle, as enforced by `skill-registry.mjs`

```text
draft --> evaluating --> approved --> active --> deprecated
```

`SKILL_STATUS_TRANSITIONS` is a strict one-way chain — no skipping states,
no going backward, and no transition out of `deprecated`:

| Transition | `approvedBy` required? |
|---|---|
| `draft -> evaluating` | no |
| `evaluating -> approved` | **yes** — `setSkillStatus` throws `approvedBy is required for skill status transition: evaluating->approved` without it |
| `approved -> active` | **yes** — same gate |
| `active -> deprecated` | no |

`APPROVAL_REQUIRED_TRANSITIONS` is exactly `{evaluating->approved,
approved->active}`. Every other transition not in the table (e.g.
`draft -> active`, `deprecated -> active`) throws `Illegal skill status
transition`. `saveSkill` (called at the end of every `setSkillStatus`) always
re-validates against `skill.schema.json`, so a transition can't leave behind
a document that fails schema.

Skills are born `draft`: `approveTopology` (`topology-planner.mjs`) writes
every proposed `skillDraft` with `status: "draft"` and no `approvedBy`.
Nothing in the shipped CLI drives a skill through `evaluating` /
`approved` / `active` — that is `recordEvaluation` +
`setSkillStatus(rootDir, id, "evaluating")` +
`setSkillStatus(rootDir, id, "approved", { approvedBy })` +
`setSkillStatus(rootDir, id, "active", { approvedBy })`, called directly
(there is no `/codex:skills` command in the MVP scope — see
`docs/TARGET_ARCHITECTURE.md` §2's deferred list).

## 5. The ACTIVE-only rule for workers

`assertSkillsActive(rootDir, refs)` is the **hard gate**. It resolves every
ref via `loadSkillByRef`, and for each one:

- missing (file not found, or id/version don't match the requested ref) →
  collected as `"<ref> (missing)"`;
- present but `status !== "active"` → collected as
  `"<ref> (status: <status>)"`;
- otherwise → included in the returned skill list.

If *any* problems were collected, it throws
`Skills not active: <problem list>` — a single non-active or missing skill
ref fails the whole batch; there is no partial-success mode.

This function is called from **two independent places**, both must pass:

1. `task-router.mjs` step 8 (`routeTask`), *after* routing has already
   chosen an owner — a routing result can still be thrown away here if a
   skill went `active -> deprecated` between agent-authoring time and
   task-routing time.
2. `campaign-orchestrator.mjs`'s `buildWorkerContext`, immediately before
   assembling the worker's system prompt — this is the actual point where a
   non-active skill would otherwise leak into a worker's context; it can't,
   because `buildWorkerContext` only ever renders skills returned by this
   assertion.

Net effect: **a worker can only ever be handed the compiled text of a skill
whose status is exactly `active`.** Draft, evaluating, approved-but-not-yet-
activated, and deprecated skills are all invisible to worker execution
context, even if an agent's `skills` array still names them.

## 6. Skill vs. memory vs. project-context vs. task

Four things a worker's context can contain, easily confused:

| Concept | Scope | Mutability | Source |
|---|---|---|---|
| **Skill** | shared across every agent that references the same `tier/name@version` | versioned, immutable once referenced (a new version is a new file/id@version pair, not an edit-in-place) | authored by the topology planner / manually, governed by the lifecycle above |
| **Memory** | namespaced per-agent / per-domain / shared | append-only, versioned per namespace (`memory-store.mjs`'s `version` counter) | worker-proposed, manager-approved (`MEMORY_GOVERNANCE.md`) |
| **Project context (`task.contextFiles`)** | per-task | read fresh from disk every run, capped at 32 KiB per file (`MAX_CONTEXT_FILE_BYTES` in `campaign-orchestrator.mjs`) | whatever the task spec lists — the manager (or whoever authors the task) decides what a worker gets to see |
| **Task** | one execution | one-shot | `goal`, `acceptanceCriteria`, `affectedPaths`, `verificationCommands` — the actual assignment |

A skill teaches "how to do this kind of work in general." Memory records
"what we learned that's durably true." Context files answer "what does this
specific task need me to look at." The task itself is the assignment. None
of the four substitute for another — `buildWorkerContext` assembles all four
into one system+user prompt pair every single call; nothing is cached
across attempts except by re-reading these same sources each time.

## 7. Where skills come from (bootstrap sources)

The topology-planning Codex turn (`prompts/orchestration/topology-proposal.md`)
is instructed to ground every `skillDraft.sources` entry in the project
profile the deterministic analyzer produced — concretely, things
`repository-analyzer.mjs` can actually detect:

- `package.json#scripts.test` / `.build` / `.lint` (or a `Makefile` `test`/
  `build`/`lint` target) — `detectCommands`;
- the test layout: dominant test directory and file-naming pattern
  (`*.test.*`, `*.spec.*`, `test_*.py`) plus inferred runner
  (`node:test`/`jest`/`vitest`/`pytest`/other) — `detectTestLayout`;
- CI workflow files under `.github/workflows/*.y*ml` — `detectCi`;
- root/`docs/` documentation files (`README.md`, `CONTRIBUTING.md`,
  `CLAUDE.md`, `AGENTS.md`, `docs/**/*.md`) — `detectDocs`;
- for this repo specifically, the MVP's chosen sources are
  `package.json#scripts.test`, `tests/helpers.mjs`, and
  `tests/fake-codex-fixture.mjs` (per `docs/MVP_PLAN.md` §2) — see
  `.ai-company.example/skills/technical/node-test-authoring.json` and
  `.ai-company.example/skills/project/codex-plugin-test-conventions.json`
  for the resulting documents.

The analyzer never invents a skill itself — it only produces the
`project-profile.json` facts; the Codex-backed planner turn is what turns
those facts into `skillDraft` proposals, schema-constrained by
`topology-proposal.schema.json` and retried once on validation failure
(`proposeTopology`'s `tryParseAndValidate` + one corrected re-prompt).
