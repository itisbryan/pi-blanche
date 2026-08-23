# Spec s02 — pi integration: extension, spawn, injection, role prompts

Owner: blanche-worker-2

## Goal

The parts that touch pi and herdr: register the `/crew` commands and the crew
tools, spawn panes, and assemble the per-turn prompt block. Plus the role
prompts the crew actually runs on.

## Scope

- `index.ts` — extension entry: commands, tools, event handlers.
- `spawn.ts` — herdr pane spawn + registration wait.
- `inject.ts` — build the per-turn prompt block (pure string assembly).
- `roles/{leader,planner,researcher,advisor,worker,qa,verifier}.md`.
- `test/inject.test.ts`.

## Out of scope

- `config.ts`, `board.ts`, `handoff.ts` and their tests — those are s01. Import
  them, do not write them.
- Do not edit `types.ts`. If the contract is wrong, message blanche-advisor.
- Parallel workers, spec scheduling, worktrees. `maxWorkers: 1`.

## Dependencies

`types.ts`, and the s01 module signatures listed in `specs/s01-core.md`. Code
against those signatures now; s01 lands independently.

## Parallel safety

parallel_safe: true — no file overlap with s01.

## Expected write scope

```
index.ts
spawn.ts
inject.ts
roles/*.md
test/inject.test.ts
```

## Implementation notes

### spawn.ts

```ts
export async function spawnRole(input: {
  role: Role; board: Board; profile: AgentProfile; cwd: string;
}): Promise<{ sessionName: string; paneId: string }>
```

Reuse the recipe pi-intercom already uses (see
`~/.pi/agent/npm/node_modules/pi-intercom/project-agent.ts`): spawn `herdr` with
`shell: false`, parse the last JSON line, map errors to codes.

```
herdr pane split --current --direction right --cwd <cwd>      -> paneId
herdr pane run <paneId> 'BLANCHE_ROLE=worker BLANCHE_TASK=t-4f2a \
  pi --name blanche-t4f2a-worker --model <model> --thinking <thinking>'
```

Session name is `{prefix}-{taskId}-{role}`. Shell-quote every interpolated
value — the command string goes through a shell in the pane.

Wait for the name to appear in the intercom session list before returning; time
out with a message naming the pane, and close the pane on failure.

### inject.ts

```ts
export function buildCrewBlock(input: {
  role: Role; board: Board; rolePrompt: string;
  specBody?: string; checkpoint?: string; consultation?: string;
  contextPct?: number; softLimit: number; peers: string[];
}): string
```

Pure string assembly, fully unit-testable. Every piece of file content arrives
as an argument — `rolePrompt`, `specBody`, `checkpoint`, `consultation` are read
by the caller in `index.ts`, never by this function. (Rev fix: the earlier
signature demanded the spec body but had no field for it, which would have
forced a file read and broken purity.)

Contains: role prompt, phase list with the current phase marked and each owner,
board summary (task, phase, owner, spec, rework), `specBody` when present, the
latest checkpoint, the latest advisor consultation, peer session names, and —
only when `contextPct >= softLimit` — the line
`CONTEXT_PRESSURE — finish this step, then call checkpoint().`

Ordering is fixed and deterministic: peers sorted, sections always in the same
order. A stable block is what keeps the provider prompt cache warm.

### index.ts

Registers:

- `pi.on("before_agent_start")` — when `BLANCHE_ROLE` is set, **return**
  `{ systemPrompt: buildCrewBlock(...) }`. Returning it is what makes it
  ephemeral: pi stores it in `_systemPromptOverride` and resets it every turn,
  so it never enters history. Do not use `pi.sendMessage` for this.
- `pi.on("session_compact")` — increment `sessions[role].contextEpoch`.
- Tools: `handoff`, `checkpoint`, `consult`. `handoff` calls `decideHandoff`,
  commits via `commitBoard`, then publishes on the intercom extension channel
  (`namespace: "blanche/v1"`, see
  `~/.pi/agent/npm/node_modules/pi-intercom/extension-api.ts`). The receiving
  side matches `taskId`/`handoffId`, dedupes, stamps `ackedAt`, and calls
  `pi.sendMessage(..., { triggerTurn: true })`.
- Commands: `/crew <workflow> "<desc>"`, `/crew status`, `/crew resume [id]`,
  `/crew stop`, `/crew clean [id]`.
- Status bar via `ctx.ui.setStatus("blanche", ...)`:
  `mb ▸ IMPLEMENTING ▸ worker ▸ s02 ▸ rework 2/3 ▸ e3`.

Context% comes from the intercom session list, which already publishes
`contextPct` per session — do not compute it.

### roles/*.md

One file per role, written from the "Roles" section of
`docs/specs/2026-08-23-pi-blanche-extension.md`. Each must state: what the role
owns, what it must never do, who to ask for facts (researcher) versus reasoning
(advisor), and when to checkpoint. The worker prompt must say: implement only
the current approved spec, never silently start the next, ask the planner to
split an oversized spec rather than redesigning it, and after repeated qa
failure stop guessing, checkpoint, and consult the advisor.

## Acceptance criteria

- `before_agent_start` returns a `systemPrompt`; nothing is appended to history.
- A pane is never left running when registration times out.
- Every interpolated value in the herdr command is shell-quoted.
- `buildCrewBlock` is pure and covered by unit tests.

## How this spec is proved

Unit tests cover `inject.ts` only — it is the pure part. The rest is proved by
**running a real pi**, not by mocking one. Building a fake `pi` object, fake
extension channel and fake `ctx` to assert that `registerCommand` was called is
scaffolding that tests the mock, not the extension.

Smoke procedure (this is the deliverable, as a script `test/smoke.sh`):

```bash
# 1. extension loads, command registers, no crash
pi --no-extensions -e ./index.ts --no-session -p '/crew status'

# 2. injection reaches the model and is NOT in history
BLANCHE_ROLE=worker BLANCHE_TASK=<seeded task> \
  pi --no-extensions -e ./index.ts --session-dir /tmp/blanche-smoke \
     -p 'Reply with the phase name you were given.'
# assert: the reply names the seeded phase   -> injection reached the model
# assert: grep -c BLANCHE_MARKER /tmp/blanche-smoke/*.jsonl == 0
#         -> the block never entered the transcript
```

That second assertion is stronger evidence than any mock: it reads the actual
persisted session file. Seed the task with `createTask` from s01.

## Test cases

### Happy path
- `buildCrewBlock` for a worker mid-spec contains the spec goal, acceptance
  criteria, latest checkpoint, and the peer list.

### Failure cases
- Registration timeout closes the pane and throws naming it.

### Edge cases
- `contextPct` below `softLimit` → no `CONTEXT_PRESSURE` line; at or above → the
  line is present exactly once.
- No checkpoint, no consultation, no `specBody` → the block still renders, with
  those sections absent rather than present-and-empty.

### Regression
- `buildCrewBlock` output is byte-identical across two calls with the same input,
  including peer ordering when the peer array arrives shuffled.
- Shell quoting: assert on the exact argv `spawnRole` would pass to herdr, with a
  cwd containing a space and a single quote, and a session name containing `$`.
  Those are the values actually interpolated — the task *title* never is, so the
  earlier "title with quotes" case was testing the wrong string.

### Not tested, deliberately
- Role markdown content. Prose files do not get assertions.
- Command/tool registration, publish/receive/dedupe/ack lifecycle, status bar.
  Covered by the smoke procedure above; mocking pi to observe them would test
  the mock.
