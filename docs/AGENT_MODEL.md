# Agent Model

Source of truth: `plugins/codex/schemas/orchestration/agent.schema.json`,
`plugins/codex/scripts/agents/agent-registry.mjs`,
`plugins/codex/scripts/agents/permission-guard.mjs`,
`plugins/codex/scripts/orchestration/task-router.mjs`. See also
`SKILL_MODEL.md` (what an agent is granted), `MEMORY_GOVERNANCE.md` (what an
agent may remember), `WORKER_RUNTIME.md` (how an agent actually executes),
`BOOTSTRAP_FLOW.md` (how agents come to exist).

## 1. What an agent IS

An agent is a **declarative identity document**: a JSON file at
`.ai-company/agents/<agent-id>.json`. It is not a model, not a prompt, not a
process. Concretely, an agent bundles:

- **ownership** — which paths it is responsible for (`primary`/`secondary`),
  and which it must never touch (`excluded`);
- **responsibilities** — a human-readable statement of its job, injected
  verbatim into worker system prompts (`buildIdentityBlock` in
  `campaign-orchestrator.mjs`);
- **skills** — the tiered, versioned procedures it is allowed to be handed
  (`SKILL_MODEL.md`);
- **memory namespaces** — which slices of durable memory get injected into
  its context;
- **permissions** — the read/write glob allowlists enforced by
  `permission-guard.mjs` at every file-tool call;
- **runtime** — which provider/model backs it; and
- **limits** — hard bounds on attempts, wall-clock time, and tool calls.

**Identity is not model.** `runtime.provider` / `runtime.model` are two plain
string fields on the document. Swapping a worker from DeepSeek to a
self-hosted OpenAI-compatible endpoint (or from `deepseek-chat` to a newer
DeepSeek model) means editing those two fields — ownership, permissions,
skills, memory, and limits are untouched. There is no per-provider agent
subclass; `OpenAICompatibleRuntime` is the same code path for every
`openai-compatible`-shaped provider (see `WORKER_RUNTIME.md` §3).

## 2. Field-by-field (`agent.schema.json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string, `^[a-z0-9][a-z0-9-]*$` | yes | Filename is `<id>.json`; also the routing/audit key. |
| `name` | string | yes | Human-readable label, shown in reports. |
| `type` | `persistent` \| `temporary` | yes | See §4. |
| `status` | `proposed` \| `active` \| `retired` | yes | Registry-enforced state machine, §5. |
| `ownership.primary` | string[] (globs) | yes | Highest weight in routing (§6). |
| `ownership.secondary` | string[] (globs) | yes | Lower weight; also drives the `support` list. |
| `ownership.excluded` | string[] (globs) | yes | Documented as never-touch; **not itself enforced** by permission-guard — see §3 caveat. |
| `responsibilities` | string[], min 1 | yes | Free text, injected into the worker system prompt. |
| `skills` | string[], each `^(core\|technical\|project\|domain)/[a-z0-9-]+@\d+\.\d+\.\d+$` | yes | Pinned tier/name@version refs; see `SKILL_MODEL.md`. |
| `memory.namespaces` | string[] | yes | Namespace strings validated by `memory-store.mjs`'s `NAMESPACE_RE` at *use* time, not at agent-save time (the agent schema does not itself constrain the string shape). |
| `permissions.read` | string[] (globs) | yes | Enforced by `permission-guard.createPermissionGuard(...).assertRead`. |
| `permissions.write` | string[] (globs) | yes | Enforced by `.assertWrite`; `.ai-company/**` and `.git/**` are always denied regardless of this list (§3). |
| `runtime.provider` | string | yes | Looked up in `provider-presets.mjs` (builtin or `.ai-company/runtimes.json` override). |
| `runtime.model` | string | yes | Passed straight to the provider's `chat/completions` call. |
| `limits.maxAttemptsPerTask` | integer ≥ 1 | yes | Capped further against `task.maxAttempts` — the review loop uses `min(task, agent)`. |
| `limits.maxExecutionMinutes` | integer ≥ 1 | yes | Wall-clock deadline for a single worker execution. |
| `limits.maxToolCalls` | integer ≥ 1 | yes | Hard cap on tool calls in one worker execution. |
| `approvals` | array of `{ role, decision, at }` | no | Appended by `setAgentStatus` on every approved transition; the audit trail for activation. |

## 3. Ownership vs. permissions vs. responsibilities vs. skills vs. memory

These five fields answer five different questions and are enforced by five
different code paths — do not conflate them:

| Concept | Answers | Enforced by | What happens if wrong |
|---|---|---|---|
| **ownership** | "whose task is this?" | `task-router.mjs` scoring (advisory ranking, not a hard gate) | wrong agent gets routed, or ends up in `support` |
| **permissions** | "what may this agent's runtime actually touch on disk?" | `permission-guard.mjs`, called from inside `OpenAICompatibleRuntime`'s tool dispatch | a `read_file`/`write_file` call throws `Permission denied` |
| **responsibilities** | "what should the agent believe its job is?" | injected as prompt text only — not code-enforced | a confused or overreaching worker (mitigated by permissions + scope rules in the system prompt, not by this field) |
| **skills** | "what procedures is this agent allowed to run?" | `assertSkillsActive` (task-router step 8, and again in `buildWorkerContext`) | routing throws if any required skill isn't ACTIVE |
| **memory namespaces** | "what durable context does this agent get?" | `listMemoryEntries(rootDir, agent.memory.namespaces)` in `buildWorkerContext` | agent gets no memory outside its granted namespaces (silently, not an error) |

**Caveat on `ownership.excluded`**: it is part of the schema and clearly
intended as a second permissions signal, but as committed, neither
`task-router.mjs` nor `permission-guard.mjs` reads it. The only file-level
enforcement is `permissions.write`/`permissions.read` plus the hardcoded
`.ai-company/**`/`.git/**` deny-list in `permission-guard.mjs`
(`ALWAYS_WRITE_DENIED_GLOBS`). Treat `ownership.excluded` today as
documentation for the topology designer (and future enforcement surface),
not as a runtime guarantee — if you need a path hard-denied, it must also be
absent from `permissions.write`.

## 4. Persistent vs. temporary agents

- **`persistent`**: a standing identity that survives across campaigns/tasks.
  Registered once, reused. The MVP ships exactly one:
  `test-and-verification-worker-01` (see `docs/MVP_PLAN.md` §2).
- **`temporary`**: instantiated for a task (or a narrow batch of tasks) and
  retired afterward. The schema allows this type, but as committed there is
  no code path that auto-creates or auto-retires a temporary agent — an
  Executive/human still has to call `saveAgent`/`setAgentStatus` (or run
  `approve-topology`, which registers whatever the proposal contains) and
  later transition it to `retired`. "Temporary" today is a declared intent
  on the document, not an automatically-managed lifecycle.

The topology planner's proposal schema (`topology-proposal.schema.json`)
uses a third, proposal-only value, `temporary-template` (a candidate for a
temporary agent), which `approveTopology` normalizes to `temporary` when it
builds the real agent document (`type === "persistent" ? "persistent" :
"temporary"` in `topology-planner.mjs`'s `buildAgentDocument`).

## 5. When NOT to create an agent (anti-patterns)

These rules are enforced as prompt instructions to the topology-planning
Codex turn (`prompts/orchestration/topology-proposal.md`), not as schema or
code constraints — a hand-authored agent document can still violate them,
nothing will reject it:

- **No utility-shaped agents.** Never a `utils`, `constants`, `types`, or
  `config` agent — these are not units of ownership, they are plumbing that
  belongs inside whichever agent's scope actually uses them.
- **Only propose `persistent` when ALL of**: it owns real, recurring
  business logic (not plumbing); it has recurring tasks, not a one-off need;
  it has independently verifiable code/tests; its permissions can be
  minimal-scope. Otherwise it should be a `temporary`/`temporary-template`
  role, not a standing identity.
- **Merge, don't multiply.** Two candidate agents with the same skills and
  the same permissions should be one agent, not two differently-named ones.
- **Prefer one persistent agent for small repos**, adding more only when the
  profile shows genuinely independent, high-cohesion ownership areas.
- **Minimal-scope permissions always** — never a blanket `**` write unless
  the repository truly has no internal boundaries.
- **Skills must be shareable** — tiered ids (`core/…`, `technical/…`,
  `project/…`, `domain/…`) so more than one agent can reference the same
  skill instead of duplicating knowledge per agent.

## 6. Registry lifecycle

`agent-registry.mjs` enforces a small, one-way state machine
(`AGENT_STATUS_TRANSITIONS`):

```text
proposed --(approval required)--> active --> retired
```

- `proposed -> active` **requires** an `approval` object
  (`{ role, decision, at }`); `setAgentStatus` throws
  `Approval is required for agent status transition` without one. The
  approval is appended to `agent.approvals` — never overwritten, so the
  document accumulates a full activation history.
- `active -> retired` requires no approval object today (any caller can
  retire an active agent) — this is looser than the skill registry's
  approval-gated transitions (`SKILL_MODEL.md` §3); if your process needs an
  approval record for retirement, enforce it at the call site.
- Any transition not in the table (e.g. `retired -> active`,
  `proposed -> retired`) throws `Illegal agent status transition`.
- `saveAgent` always re-validates the full document against
  `agent.schema.json` before writing — a transition cannot silently produce
  an invalid document.

In practice, agents reach `active` exactly one way in the shipped code:
`topology-planner.mjs`'s `approveTopology(rootDir, { approvedBy })`, called
from `/codex:bootstrap-agents --approve --approved-by <role>`. It builds
every proposed agent as `status: "proposed"`, saves it, then immediately
calls `setAgentStatus(..., "active", { role: approvedBy, decision: "approve",
at })` — so in the bootstrap flow "proposed" is a transient, same-call state
rather than something that sits around waiting for a second approval step.
Nothing else in the shipped CLI creates or activates an agent outside this
path.

## 7. How routing selects an owner (`task-router.mjs`)

`routeTask(rootDir, task, { agents })` is pure code — no LLM call — and runs
in this exact order:

1. **Validate** the task document against `task.schema.json`.
2. **Filter to `status: "active"` agents only.** Proposed/retired agents are
   never routable.
3. **Skill filter first** (per spec order): an agent survives only if
   `agent.skills` includes *every* ref in `task.requiredSkills` (exact
   string match, e.g. `"technical/node-test-authoring@1.0.0"`). If nobody
   survives, `routeTask` throws `No active agent has the required skills`.
4. **Ownership scoring second**, only among skill-eligible agents: count how
   many of `task.affectedPaths` each agent's `ownership.primary` globs match,
   then how many its `ownership.secondary` globs match
   (`matchGlob` from `permission-guard.mjs`, reused for scoring — not for
   permission checks here). Sort by `(primaryCount desc, secondaryCount
   desc, agent.id asc)` — the id tiebreak makes routing deterministic.
5. **Preset owner override**: if `task.owner` is a non-empty string, that
   agent must appear in the skill-eligible set or `routeTask` throws
   `Preset owner <id> is not eligible`; otherwise it wins outright,
   regardless of score. (`task.owner` is a *required* schema field but an
   empty string `""` is falsy in JS and is the documented way to say "let
   routing decide" — see `tests/task-router.test.mjs`'s `makeTask` helper.)
6. **`support`**: every other skill-eligible agent with any ownership
   overlap (primary or secondary count > 0), sorted by id.
7. **`writeGaps`**: affected paths the chosen owner's `permissions.write`
   globs don't cover. This is a **warning**, not a throw — `routeTask`
   still returns a result; `runCampaignTask` records a
   `routing_write_gaps` audit event and proceeds. A worker hitting one of
   these paths will still get a `Permission denied` from the runtime at
   execution time; routing does not pre-empt that.
8. **Hard skill gate, last**: `assertSkillsActive(rootDir, requiredSkills)`
   re-checks that every required skill actually resolves and is
   `status: "active"` (not just referenced in `agent.skills`) — this can
   still throw here even after step 3 passed, if a skill was deprecated or
   deleted between when the agent document was written and when the task is
   routed.

`routeTask` returns `{ owner, support, writeGaps }`; nothing about routing
mutates the agent registry or the task document — persistence is the
caller's job (`review-loop.mjs`'s `persistTask`).
