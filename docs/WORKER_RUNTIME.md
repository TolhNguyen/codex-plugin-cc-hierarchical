# Worker Runtime

Source of truth: `plugins/codex/scripts/runtimes/runtime-base.mjs`,
`plugins/codex/scripts/runtimes/codex-runtime.mjs`,
`plugins/codex/scripts/runtimes/openai-compatible-runtime.mjs`,
`plugins/codex/scripts/runtimes/provider-presets.mjs`,
`plugins/codex/scripts/agents/permission-guard.mjs`. See also
`AGENT_MODEL.md` §2 (`runtime.provider`/`runtime.model`), `SKILL_MODEL.md`
§6, `MEMORY_GOVERNANCE.md` §4 (what context a worker actually receives).

## 1. The `AgentRuntime` contract and `RuntimeResult`

Every runtime (manager or worker) implements the same three-function shape
(`runtime-base.mjs`'s doc comment):

```js
{
  async execute(agent, task, context) { /* -> RuntimeResult */ },
  async cancel(executionId) { /* -> { attempted: boolean, ... } */ },
  getStatus(executionId) { /* -> { executionId, state, ... } | null */ }
}
```

`createRuntimeResult(fields)` validates and normalizes a `RuntimeResult`,
filling defaults and returning a **frozen** shallow copy (`Object.freeze`) —
callers cannot mutate a persisted result after construction:

| Field | Type | Notes |
|---|---|---|
| `executionId` | string | `generateExecutionId()` → `exec-<time base36>-<6 random base36 chars>`, same family as `lib/state.mjs`'s job ids. |
| `agentId` | string | Required non-empty. |
| `role` | `"manager"` \| `"worker"` | Enforced enum. |
| `status` | `"completed"` \| `"failed"` \| `"cancelled"` \| `"timeout"` | Enforced enum — this is the *transport/execution* status, distinct from a task-result's own `status` field (`completed`/`needs_review`/`failed`/`escalate`), which lives one layer up inside `output`. |
| `output` | string | The final message/JSON text; required to be a string (possibly empty). |
| `toolCalls` | `{ tool, args, result, ok }[]` | Defaults to `[]`; copied, not aliased. |
| `usage` | `{ inputTokens, outputTokens, calls }` | Missing fields default to `null`/`0`. |
| `startedAt` / `endedAt` | ISO string | Both required non-empty. |
| `error` | string \| null | Defaults to `null`. |

`writeExecutionRecord(rootDir, result, extra)` persists the result (plus any
runtime-specific `extra`, e.g. Codex `threadId`/`turnId` or the raw worker
`transcript`) as pretty JSON at
`.ai-company/executions/<executionId>.json`. `readExecutionRecord` reads it
back, or returns `null` if absent. Every execution — manager or worker,
success or failure — gets exactly one of these files; this is the raw
transcript layer underneath the task/campaign audit log.

## 2. The two implementations

| | `CodexRuntime` (manager) | `OpenAICompatibleRuntime` (worker) |
|---|---|---|
| File | `codex-runtime.mjs` | `openai-compatible-runtime.mjs` |
| Transport | wraps the existing `runAppServerTurn` (the same app-server/broker path documented in `CURRENT_ARCHITECTURE.md` §4–5) | `fetch(POST {baseUrl}/chat/completions)`, zero deps |
| Sandbox | **hardcoded** `MANAGER_SANDBOX = "read-only"` — never accepts a writable sandbox from any caller, at any layer | none at the HTTP layer; all containment comes from `permission-guard` on each file tool |
| `context.prompt` | required, pre-assembled by the caller (topology planner, review loop, memory reviewer) — this runtime does not build prompts | `context.systemPrompt` + `context.userPrompt`, both required non-empty; also caller-assembled (`buildWorkerContext`) |
| `cancel` | calls `interruptAppServerTurn` with the tracked `threadId`/`turnId`; returns `{ attempted: false }` if neither was ever observed | sets `cancelRequested` and aborts the in-flight `fetch` via `AbortController`; checked at multiple points in the loop (§3) |
| Failure on transport throw | caught, turned into a `status: "failed"` `RuntimeResult` with `error` set to the thrown message — **never rethrown** | same discipline: `execute()` "never throws once inputs are validated" (module doc comment) — every path ends in a persisted result |
| Usage accounting | `{ inputTokens: null, outputTokens: null, calls: 1 }` — Codex doesn't report token usage through this path yet | real token accounting from the API response's `usage` field when present, else `null`/`null` (never fabricated as `0`) |

## 3. The worker tool loop: 5 tools and their guards

`OpenAICompatibleRuntime.execute` drives a bounded loop against
`chat/completions` with exactly these tool definitions (`TOOL_DEFS`) — this
is the entire surface a worker model can act through:

| Tool | Args | Guard / constraint |
|---|---|---|
| `read_file` | `{ path }` | `guard.assertRead(path)` (`permission-guard.mjs`); capped at 64 KiB (`MAX_FILE_READ_BYTES`), else `"ERROR: file too large"`. |
| `list_dir` | `{ path }` | `guard.assertRead(path)`; capped at 200 entries (`MAX_DIR_ENTRIES`), directories suffixed `/`. |
| `write_file` | `{ path, content }` | `guard.assertWrite(path)`; creates parent dirs; writes UTF-8 unconditionally (non-string `content` is coerced to `""`, not rejected). |
| `run_command` | `{ command }` | **exact string match** against `task.verificationCommands` — anything else returns `"ERROR: command not allowed: <command>"` without running. Runs via `spawnSync(..., { shell: true, timeout: 120000ms, maxBuffer: 20MiB })`; output capped at 10 KiB (`MAX_COMMAND_OUTPUT_CHARS`). |
| `submit_result` | `{ result }` | Validated against `task-result.schema.json`. Invalid → `"ERROR: <errors> — fix and resubmit"` fed back as the tool result (one repair opportunity); a **second** consecutive invalid submission finishes the whole execution as `status: "failed"`, `error: "submit_result failed schema validation twice"` (`invalidSubmitCount >= 2`). A valid submission ends the loop immediately with `status: "completed"`. |

`read_file`/`list_dir` use `assertRead`; `write_file` uses `assertWrite` —
both are built once per execution via
`createPermissionGuard(rootDir, agent.permissions)` and reused for every
tool call in that run (§ "security rules" below has the containment
details). If the model finishes a turn with no tool calls at all, it is
nudged once (`NUDGE_MESSAGE`: "You must call submit_result...") — a second
consecutive no-tool-call turn ends the execution as `failed`.

## 4. Bounds: maxToolCalls AND wall-clock

Two independent caps, both checked repeatedly, not just once at the start:

- **`limits.maxToolCalls`** (from `agent.limits.maxToolCalls`, default `40`
  if absent): checked before dispatching each individual tool call inside a
  turn (`toolCalls.length + 1 > maxToolCalls` → `status: "failed"`, error
  `"tool call limit exceeded"`).
- **`limits.maxExecutionMinutes`** (default `20`): converted once to an
  absolute `deadlineMs` at execution start; re-checked at the top of every
  loop iteration and again before processing each tool call inside a turn.
  Exceeding it produces `status: "timeout"` (not `"failed"` — timeout is
  its own first-class status, distinguishable in audits/reports from a
  genuine error).

Both checks also run *after* a cancellation check at the same points, so a
long-running loop can't outlive either bound even if it's mid-turn when the
deadline passes.

## 5. Failure semantics: caller bugs THROW, transport/env failures RETURN

This distinction is load-bearing throughout the orchestration layer (see
`review-loop.mjs`'s comment on the same split):

- **Caller bugs throw** — e.g. `execute()` throws synchronously if
  `context.systemPrompt`/`context.userPrompt` is missing/empty, or if
  `agent`/`agent.id` is malformed. These are programming errors in the
  code that invoked the runtime, not something a real campaign run should
  ever hit in production; they are not caught internally, so they propagate
  to the caller (`runReviewLoop` catches them at the call site and turns
  them into a `"halted"` loop outcome with an audit event — see
  `BOOTSTRAP_FLOW.md`).
- **Transport/environment failures return a persisted result.** A network
  error, a non-2xx HTTP response, a missing API key, an unknown provider,
  hitting `maxToolCalls`, hitting the wall-clock deadline, or two
  consecutive invalid `submit_result` calls — none of these throw. Each
  produces a `finish(status, output, error, extra)` call, which always
  writes an `.ai-company/executions/<id>.json` record before returning.
  This is what lets `review-loop.mjs` treat "the worker's runtime failed"
  as ordinary data (`workerResult.status !== "completed"` triggers a
  locally-synthesized rework/escalate decision, §`BOOTSTRAP_FLOW.md`)
  instead of an exception to catch.

## 6. Cancellation

`cancel(executionId)` on the worker runtime: no-ops with
`{ attempted: false }` if the execution is unknown or already `"done"`;
otherwise sets `cancelRequested = true` and aborts the live
`AbortController` if a request is in flight. The loop checks
`cancelRequested` at four points (top of loop, after a network error, and
before/inside the per-tool-call inner loop), each returning
`status: "cancelled"`. On the manager runtime, `cancel` only has an effect
once a `threadId`/`turnId` pair has actually been observed via
`onProgress` — before that, it also returns `{ attempted: false }`.

## 7. Provider presets and adding a new provider

`provider-presets.mjs` treats a "provider" as pure transport coordinates —
resolving one never touches the network and never persists a resolved API
key. Built-ins (`BUILTIN_PROVIDERS`):

| id | `baseUrlEnv` | default base URL | `apiKeyEnv` | default model |
|---|---|---|---|---|
| `deepseek` | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `openai-compatible` | `OPENAI_COMPAT_BASE_URL` | *(none)* | `OPENAI_COMPAT_API_KEY` | *(none)* |

`resolveProvider(providerId, { env, rootDir })` merges (override wins) a
built-in preset with any same-id entry from
`<rootDir>/.ai-company/runtimes.json` — a project-local, git-visible file
mapping **provider id → preset fields**
(`baseUrlEnv`/`defaultBaseUrl`/`apiKeyEnv`/`defaultModel`). A malformed or
missing `runtimes.json` is swallowed and treated as "no overrides" (never
throws). **To add a brand-new provider** (not just override a built-in),
add a new top-level key to `runtimes.json` — `resolveProvider` only
requires that *either* a built-in *or* an override exists for the
requested id; a wholly custom id with only an override entry works fine.
See `.ai-company.example/runtimes.json` for a worked example that overrides
`deepseek` and adds an unrelated custom provider id.

**Known inconsistency to watch for**: `topology-planner.mjs`'s
`buildAgentDocument` hardcodes every approved agent's `runtime` to
`{ provider: "openai-compatible", model: "deepseek-chat" }` regardless of
what the topology proposal actually recommended. `"openai-compatible"`
resolves against `OPENAI_COMPAT_BASE_URL`/`OPENAI_COMPAT_API_KEY` (no
default base URL), not DeepSeek's real endpoint — so an agent registered
straight out of `approve-topology` will fail with `Missing base URL: set
OPENAI_COMPAT_BASE_URL` unless you either set that env var to DeepSeek's
API or manually edit the agent's `runtime.provider` to `"deepseek"` after
registration. The example config in `.ai-company.example/` uses the
internally-consistent `provider: "deepseek"` pairing on purpose.

## 8. Security rules

- **The API key never touches disk.** `resolveProvider` reads it from `env`
  at call time into a local variable (`provider.apiKey`); it is used
  exactly once, as the `Authorization: Bearer <key>` header value on the
  outbound `fetch`. It is never written into an execution record, a tool
  message, an error message, `runtimes.json`, or a log line — check any new
  code path against this before shipping it (per the module's own header
  comment: "do not weaken without re-reading `docs/TARGET_ARCHITECTURE.md`
  §4").
- **Every file tool is guarded, no exceptions.** `read_file`/`list_dir` go
  through `assertRead`; `write_file` goes through `assertWrite`. Both
  resolve the caller-supplied relative path via
  `resolveAndCheckContainment` (lexical `..`/absolute-path rejection,
  **then** a symlink-aware `realpath` check so a symlink pointing outside
  `rootDir` is caught even for a not-yet-existing write target — see
  `permission-guard.mjs`'s `realpathDeepestExisting`), then matches the
  canonical, `.`/`..`-free, forward-slash-normalized relative path against
  the agent's glob lists. `write_file` additionally always denies
  `.ai-company/**` and `.git/**` regardless of the agent's own
  `permissions.write` (`ALWAYS_WRITE_DENIED_GLOBS`) — this is what backs
  `MEMORY_GOVERNANCE.md` §1's layer 1. On win32, path comparisons are
  case-insensitive; glob matching itself uses a case-insensitive regex.
- **`run_command` cannot run arbitrary commands** — only an exact string
  present in `task.verificationCommands`, which is authored by whoever
  wrote the task (the manager/Executive side), never by the worker.
