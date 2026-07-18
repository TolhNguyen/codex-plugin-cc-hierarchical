# MVP Validation Artifacts

Recorded artifacts from real end-to-end campaign runs of the hierarchical agent runtime on this
repository (spec §25 acceptance criterion 15, `docs/MVP_PLAN.md` commit 11). All runs used the
real DeepSeek worker (`deepseek-chat`) and the real Codex manager; secrets are handled via
env-name indirection, so nothing here required scrubbing beyond replacing one absolute local
path in `drafts/manifest.json` with its repo-relative form.

## Runs

### `camp-mrorxu1n-p6et` — "unleashed" DeepSeek experiment (2026-07-17)

Brief: cheap worker writes unit tests for `lib/args.mjs` with deliberately high limits
(300 tool calls, 150 worker calls) to observe unconstrained behavior.

Outcome: **approved on attempt 1** — the worker used 8 of 300 tool calls, one worker call,
one manager review, estimated cost **$0.0242**. Result landed as commit `47cff4c`
(`test: add unit tests for lib/args.mjs`). The campaign later paused when a second task hit
the budget deadline (`task-prompts-01` shows `outcome: "halted"` in `taskStats` — the
per-task cost attribution added by the cost-inversion guardrails).

### `camp-mrpa0bw3-qacz` — worker execution path + plan-to-tasks (2026-07-17)

Brief: demonstrate the worker execution path end-to-end — worker writes `node:test` unit
tests for `lib/prompts.mjs`, Codex manager reviews.

Outcome: **approved on attempt 1** — one worker call, estimated cost **$0.0091**, audit trail
covers the full sequence (`campaign_created` → approval → `task_attempt_started` →
`worker_result` → `review_decision` → `loop_finished`). Result landed as commit `98204f7`
(`test: add unit tests for lib/prompts.mjs`).

The same campaign then exercised `campaign plan-to-tasks`: one manager call decomposed a
5-item plan into **1 run-ready worker draft, 0 needs-attention, 4 kept in the expensive tier**
(see `drafts/manifest.json`, audit event `plan_decomposed`) — the tier classifier correctly
refused to push architecture/design work down to the cheap tier.

## Acceptance criteria evidenced here

| Spec §25 | Evidence |
|---|---|
| 6 — worker runs on a cheap model | both campaigns: `runtime.provider: deepseek`, per-provider cost in `usage` |
| 8–9 — bounded review loop | audit logs: attempt-numbered events, `loop_finished` with attempts count |
| 13 — audit logs | `campaigns/*/audit.jsonl` (copies of the live `audit.log`, one JSON event per line) |
| 14 — budget limits | `campaign.json` budgets + `halted` outcome when the deadline tripped |
| 15 — one real campaign end-to-end | both runs above, with resulting commits on `main` |

Raw execution transcripts stay in the local `.ai-company/executions/` store (gitignored); the
files here are the governance artifacts: campaign state, task definitions, draft manifests,
agent definition, and audit logs.
