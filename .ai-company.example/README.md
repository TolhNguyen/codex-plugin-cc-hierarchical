# `.ai-company.example/` — template, not live config

This directory is a **template**. Copy it to `.ai-company/` at the root of
the repository you're bootstrapping the orchestration layer into:

```bash
cp -r .ai-company.example .ai-company
```

None of the files here are read by the plugin from this location — the
code always looks under `<repo-root>/.ai-company/`. This example exists so
you can see one complete, internally-consistent, schema-valid instance of
every file kind before running `/codex:bootstrap-agents` for real. It
happens to model the actual MVP topology this repository (`codex-plugin-cc`)
converges on per `docs/MVP_PLAN.md` §2 — one persistent worker agent, three
skills, one campaign-scoped memory namespace — but the shapes are what
matter, not the specific repo it describes.

Every JSON file below (except `runtimes.json`, which has no JSON Schema)
was validated against its schema in
`plugins/codex/schemas/orchestration/*.schema.json` using the project's own
`validateAgainstSchema`/`loadOrchestrationSchema` — see the Task 10 report
for the exact command run.

## Files

| File | Schema | Produced by (in real use) | Notes |
|---|---|---|---|
| `project-profile.json` | `project-profile.schema.json` | `repository-analyzer.mjs` (`bootstrap`/`bootstrap --profile-only`) | This is real output from running the analyzer against this repository — not fabricated data, only the timestamp was normalized for readability. |
| `topology-proposal.json` | `topology-proposal.schema.json` | `topology-planner.mjs`'s `proposeTopology` (one Codex turn) | Pre-approval draft. Agents here use `type: persistent`/`temporary-template` and carry a `rationale` field that the *registered* agent document (below) does not — the proposal and the final agent record are different shapes on purpose (see `docs/AGENT_MODEL.md` §4). |
| `runtimes.json` | *(none — no schema file exists for this shape)* | authored by a human, or left absent (built-ins alone are enough for `deepseek`/`openai-compatible`) | **Env-var names only, never actual keys.** Shows overriding a built-in (`deepseek`) and adding a brand-new provider id (`local-vllm`) that has no built-in at all — see `docs/WORKER_RUNTIME.md` §7. |
| `agents/test-and-verification-worker-01.json` | `agent.schema.json` | `topology-planner.mjs`'s `approveTopology` (`/codex:bootstrap-agents --approve --approved-by <role>`) | `status: "active"` with an `approvals` record, i.e. the **post-approval** state. Uses `runtime.provider: "deepseek"` intentionally — see the divergence note below. |
| `skills/core/task-execution.json` | `skill.schema.json` | intended to ship as static plugin content copied at bootstrap (per `docs/MVP_PLAN.md` §2) | **Not actually produced by any shipped code path** — see the divergence note below. Shown here already `active` with `approvedBy` set, i.e. the end state after manual evaluation. |
| `skills/technical/node-test-authoring.json` | `skill.schema.json` | a `skillDraft` in `topology-proposal.json`, registered `draft` by `approveTopology`, then driven to `active` manually (`docs/BOOTSTRAP_FLOW.md` §2.4) | Shown here already `active`/`approvedBy` set — the end state, not the just-registered `draft` state. |
| `skills/project/codex-plugin-test-conventions.json` | `skill.schema.json` | same as above | Same note. |
| `memory/shared/project__shared.json` | *(none — memory documents have no JSON Schema)* | `memory-store.mjs`'s `appendMemoryEntry`, called only from `applyDecision` on an approved/edited memory proposal | Namespace `project/shared` maps to this exact path (`memory/shared/project__shared.json`) via `namespaceToPath`'s slug rule — see `docs/MEMORY_GOVERNANCE.md` §3. |

## Known divergences from the design docs (see the full docs for detail)

- **Core skills are not auto-copied at bootstrap.** `docs/MVP_PLAN.md` §2
  says core skills "ship as static plugin content ... and are copied into
  `.ai-company/` at bootstrap." No such static content or copy step exists
  in the shipped code (`plugins/codex/skills-orchestration/core/` does not
  exist; `topology-planner.mjs` only ever registers the `skillDrafts` a
  Codex turn proposed). If your agent references a `core/*` skill, you
  must author and register it yourself, as this example does for
  `core/task-execution.json`. See `docs/SKILL_MODEL.md` §2.
- **`approveTopology` hardcodes worker `runtime`.** The real
  `buildAgentDocument` in `topology-planner.mjs` always sets
  `runtime: { provider: "openai-compatible", model: "deepseek-chat" }` on
  every approved agent, regardless of the proposal — which resolves
  against `OPENAI_COMPAT_BASE_URL` (no default) rather than DeepSeek's real
  endpoint, and would fail with a missing-base-URL error out of the box.
  This example intentionally uses the actually-working
  `runtime.provider: "deepseek"` pairing instead. See
  `docs/WORKER_RUNTIME.md` §7.

## What's NOT shown here

`campaigns/<id>/` (campaign document, task documents, `audit.log`) and
`executions/<id>.json` (raw runtime transcripts) are runtime artifacts
generated while a campaign actually runs — they aren't part of a template
because they don't exist until you create and run one. See
`docs/BOOTSTRAP_FLOW.md` for the full command sequence that produces them.
`memory/proposals/<id>.json` (pending/decided memory proposals) is the same
kind of runtime artifact, generated by `campaign run-task` and consumed by
`campaign review-proposals` — see `docs/MEMORY_GOVERNANCE.md`.
