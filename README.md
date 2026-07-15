# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

> **This is an independent fork.** It keeps every original Codex feature below and adds a
> **[Hierarchical Agent Runtime](#hierarchical-agent-runtime-fork-extension)** — a 3-tier
> Executive / Manager / Worker orchestration layer that can run a bounded, budgeted "campaign"
> of work using a cheap OpenAI-compatible model (e.g. DeepSeek) as the worker. Not affiliated
> with or endorsed by OpenAI. Licensed under Apache-2.0 (see `LICENSE`/`NOTICE`).

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add openai/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@openai-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Hierarchical Agent Runtime (fork extension)

This fork adds an orchestration layer on top of the Codex integration. It treats a large piece of
work as a **campaign** run by a small AI "company" with three tiers:

- **Executive** — you + Claude in this session. Sets the goal and acceptance criteria, approves
  plans, and signs off. No extra API keys; it is just the interactive session.
- **Manager** — Codex, via the same app-server this plugin already uses. Analyzes the repo,
  proposes an agent topology, routes tasks, and reviews worker output with schema-constrained
  decisions.
- **Worker** — a cheap OpenAI-compatible model (DeepSeek by default) running a **bounded** tool
  loop (read/list/write files, run allow-listed verification commands, submit a structured
  result). Workers only ever see assembled context — never the whole repo.

Agent identity is independent of the model: an agent is `ownership + responsibilities + skills +
memory + permissions + runtime`, and the runtime (provider/model) can be swapped without losing
anything else.

### Requirements (worker tier)

The Manager (Codex) uses your existing Codex login. The Worker tier needs an OpenAI-compatible
endpoint, supplied via environment variables (keys are **never** written to disk — config files
store env-var *names* only):

```bash
# DeepSeek (default preset)
export DEEPSEEK_API_KEY=sk-...
# or any OpenAI-compatible endpoint
export OPENAI_COMPAT_BASE_URL=https://your-endpoint/v1
export OPENAI_COMPAT_API_KEY=...
```

### Commands

- `/codex:bootstrap-agents` — analyze the repository and propose an agent topology + draft skills.
  Nothing is activated automatically. Approve with
  `/codex:bootstrap-agents --approve --approved-by <role>`.
- `/codex:skill list` / `/codex:skill activate <skill-id> --approved-by <role>` — move a skill
  `draft → active` so routing and workers may use it.
- `/codex:campaign <create|list|show|run-task|approve|review-proposals|accept>` — run a campaign
  end-to-end. Approvals, memory decisions, and final acceptance each require an explicit role
  argument; nothing auto-approves.

### Quickstart

```bash
export DEEPSEEK_API_KEY=sk-...

/codex:bootstrap-agents                                  # propose topology (writes .ai-company/)
/codex:bootstrap-agents --approve --approved-by you      # register agents (active) + skills (draft)
/codex:skill activate technical/node-test-authoring --approved-by you

/codex:campaign create --brief "Add tests for the review loop"
/codex:campaign approve <campaignId> --approved-by you   # draft/awaiting_approval -> running
/codex:campaign run-task <campaignId> --task-file task.json
/codex:campaign review-proposals <campaignId> --decided-by you
/codex:campaign accept <campaignId> --accepted-by you    # Executive sign-off
```

### Guardrails (enforced in code, not just prompts)

- **Bounded everything** — the review loop caps attempts; the worker tool loop caps tool calls
  and wall-clock time; a per-campaign budget throttles Executive/Manager/Worker calls and pauses
  the campaign (never crashes, never silently continues) when a limit is hit.
- **Least privilege** — workers read/write only paths their agent permits; the `.ai-company/`
  governance store is always read- and write-denied to workers; context files are permission-guarded.
- **Governed memory** — workers can only *propose* memory; a Manager decision (with an explicit
  approver) is required before anything becomes durable, and rejected proposals are kept for audit.
- **Auditable** — every routing, attempt, review, budget event, and memory decision is appended to
  a per-campaign JSONL audit log.

All campaign state lives under `.ai-company/` in your repo. A ready-to-copy example config is in
[`.ai-company.example/`](./.ai-company.example/).

### Documentation

| Doc | Covers |
|---|---|
| [`docs/TARGET_ARCHITECTURE.md`](./docs/TARGET_ARCHITECTURE.md) | Overall design of the 3-tier runtime |
| [`docs/AGENT_MODEL.md`](./docs/AGENT_MODEL.md) | What an agent is; ownership, permissions, routing |
| [`docs/SKILL_MODEL.md`](./docs/SKILL_MODEL.md) | Skill tiers and the draft→active lifecycle |
| [`docs/MEMORY_GOVERNANCE.md`](./docs/MEMORY_GOVERNANCE.md) | Proposal → decision → versioned memory |
| [`docs/WORKER_RUNTIME.md`](./docs/WORKER_RUNTIME.md) | Runtime contract, the worker tool loop, providers |
| [`docs/BOOTSTRAP_FLOW.md`](./docs/BOOTSTRAP_FLOW.md) | End-to-end bootstrap → campaign walkthrough |
| [`docs/CURRENT_ARCHITECTURE.md`](./docs/CURRENT_ARCHITECTURE.md) | The original plugin this builds on |

### Status & known gaps

The runtime is implemented and covered by tests (Node's built-in test runner, no new runtime
dependencies). It has been validated end-to-end against local fixtures; a real campaign run
requires a worker API key. Known gaps, tracked for follow-up:

- `agent.ownership.excluded` is present in the schema but not yet enforced by routing.
- Core skills are not yet auto-copied into `.ai-company/` at bootstrap.

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
