# pi-blanche

[![CI](https://github.com/itisbryan/pi-blanche/actions/workflows/ci.yml/badge.svg)](https://github.com/itisbryan/pi-blanche/actions/workflows/ci.yml)

Spin up a crew of [pi](https://github.com/badlogic/pi-mono) sessions — planner,
researcher, advisor, worker, qa, verifier — each in its own
[herdr](https://herdr.dev) pane, on its own model and reasoning budget,
coordinating over [pi-intercom](https://www.npmjs.com/package/pi-intercom).

```
/crew feat "add audits export"
```

You stay the leader. The crew works in your repo, hands off through a tool that
records what happened, and leaves durable state on disk so the task survives a
crash, a restart, or a context compaction.

## Why

Two ideas the whole thing is built around:

> Use expensive intelligence to decide; use cheap agents to execute; escalate
> instead of making every agent expensive.

> Long-lived tasks, short-lived contexts.

The first is why a `worker` runs at `thinking: low` while an `advisor` runs at
`xhigh` and is consulted only when the worker gets stuck. The second is why the
requirement, the plan, the specs, advisor conclusions and checkpoints are all
files — not conversation that a compaction can eat.

## Install

```bash
pi install git:github.com/itisbryan/pi-blanche
```

Not on npm. For local development, clone and `pi --extension ./index.ts`.

Requires pi, herdr 0.7.5+, and pi-intercom.

## Configure

`~/.pi/agent/pi-blanche.json` — written with defaults on first use.

```json
{
  "agents": {
    "planner":    { "model": "claude-bridge/claude-opus-5",   "thinking": "high" },
    "researcher": { "model": "openai-codex/gpt-5.6-luna",     "thinking": "medium" },
    "advisor":    { "model": "openai-codex/gpt-5.6-luna",     "thinking": "xhigh" },
    "worker":     { "model": "claude-bridge/claude-sonnet-5", "thinking": "low" },
    "qa":         { "model": "claude-bridge/claude-sonnet-5", "thinking": "low" },
    "verifier":   { "model": "claude-bridge/claude-opus-5",   "thinking": "high" }
  },
  "context": { "softLimit": 0.65 },
  "workflows": { "...": "seven presets, see below" }
}
```

## Workflows

Each is a task *shape* and carries the ceremony that shape needs. There is no
separate risk axis — a high-risk `quick` is a `fix`, a low-risk `fix` is a
`quick`.

| Workflow | Crew | Phases |
|---|---|---|
| `quick` | worker, qa | IMPLEMENTING → QA |
| `fix` | +researcher, advisor, verifier | REPRODUCE → DIAGNOSE → IMPLEMENTING → QA → VERIFY |
| `hotfix` | advisor, worker, qa | TRIAGE → IMPLEMENTING → TARGETED_QA → LEADER_REVIEW |
| `feat` | full crew | DISCOVERY → PLANNING → PLAN_REVIEW → IMPLEMENTING → QA → VERIFY |
| `refactor` | planner, advisor, worker, qa, verifier | BASELINE → PLANNING → IMPLEMENTING → REGRESSION_QA → VERIFY |
| `investigate` | researcher, advisor | INVESTIGATING → REPORT |
| `review` | qa, verifier, advisor | QA → VERIFY |

## Commands

| | |
|---|---|
| `/crew <workflow> "<desc>"` | spawn the crew and start |
| `/crew status` | phase, owner, spec, rework, per-role epoch and context% |
| `/crew resume [id]` | respawn missing panes, replay state, continue |
| `/crew stop` | pause delivery; phase, panes and files untouched |
| `/crew clean [id]` | close the panes it opened, delete the task directory |

## Tools the crew uses

- **`handoff({ to, phase, spec?, message, verdict? })`** — moves the task and
  delivers the message in one call, so the board can never disagree with what
  was actually said. `qa` returns `PASS|FAIL`, `verifier` returns
  `APPROVED|CHANGES`.
- **`checkpoint({ completed, decisions, failedApproaches, currentFailures, ... })`**
  — durable continuation state per role per epoch. `failedApproaches` is the
  highest-value field: *"Redis lock around the controller; the race happens
  before the lock is acquired"* is exactly what the next context must not
  rediscover.
- **`consult({ role, requestedBy, answer })`** — the advisor records a
  conclusion. Asking is an ordinary intercom message; only the answer persists.

## Escalation

Rework is counted per spec. After `advisorAfter` failed rounds the worker is
told to stop guessing, checkpoint, and consult the advisor — and the nudge
repeats every round until advice actually lands. After `maxRework` the handoff
is refused and routed to you. That refusal is the only thing pi-blanche
enforces; everything else is advisory.

## Task directory

`~/.pi/agent/pi-blanche/tasks/<id>/`

```
board.json        runtime state, references everything else
task.md           the original requirement
plan.md           the approved plan
specs/            small, independently verifiable units
consultations/    distilled advisor conclusions
checkpoints/      durable continuation state
```

The test this is designed against: *if every pi transcript disappeared right
now, could `/crew resume` reconstruct enough truth for each role to continue?*

## Development

```bash
npm run verify    # biome ci + tsc --noEmit + guard + node --test
npm run format
BLANCHE_E2E=1 npm run e2e  # optional: real Herdr pane + model delivery turn
BLANCHE_CLAUDE_BRIDGE=1 npm run e2e  # optional: claude-bridge tool-schema smoke
npm run load-window  # real pi load with an active task; checks source + installed copy
```

`test/guard.sh` fails if any source file does not load or any test file contains
no assertion — a passing no-op test is a green light on nothing.

## Status

All four build specs are implemented and reviewed; 52 tests green, plus lint and
typecheck in CI.

**A live `/crew` kickoff passes end to end.** Real herdr panes, both agents
registered on the broker, the opening handoff delivered and acknowledged without
intervention, and the receiving agent ran a real turn. Getting there took four
defects that no test could see, all in the seam between the extension and its
host — [`docs/verification.md` §7.4](docs/verification.md#74-live-verification)
records them.

Not yet run live: a full multi-role cycle (worker → qa → verifier with a rework
loop and an advisor escalation). Only the opening handoff of a two-role
`investigate` has.

Deferred by design: parallel workers (`maxWorkers: 1`), enforcing the workflow
beyond the rework bound, owning compaction, worktrees.

## Design

[`docs/architecture.md`](docs/architecture.md) is the index. Seven sections:

| Section | |
|---|---|
| §1 [The model](docs/model.md) | problem, state partition, what may be destroyed |
| §2 [L-Thread](docs/l-thread.md) | continuing work across contexts that keep dying |
| §3 [Compaction](docs/compaction.md) | why the system does *not* own compaction |
| §4 [Crew](docs/crew.md) | roles, capability allocation, workflow shapes |
| §5 [Handoff](docs/handoff.md) | how the task advances; how a stuck loop terminates |
| §6 [Consistency](docs/consistency.md) | concurrent mutation of one board |
| §7 [Verification](docs/verification.md) | what is proven, and three defects a green suite missed |

## License

MIT
