# Spec s03 — Extension core: kickoff, injection wiring, handoff round trip

Owner: blanche-worker-2

## Why this spec exists

s02 was too large. It bundled inject, spawn, seven role prompts, five commands,
three tools and the channel receiver into one unit, and the design's own rule
says a spec is too large when the worker cannot state its goal, boundary and
proof in a short packet. The proof work landed; the wiring did not.

s02 is now closed at its real scope — `inject.ts`, `spawn.ts`, `roles/*.md` and
their tests, all validated. This spec is the wiring, and it is the half that
makes the extension actually run.

## Goal

A crew you can start and hand off inside. After this spec, `/crew feat "..."`
spawns real panes and a `handoff` from one session starts a turn in another.

## Scope

- `index.ts` — registration, kickoff, status, injection wiring, compaction
  epoch, the `handoff` tool, and the receiving side.
- `test/receive.test.ts` — pure tests for the receive decision.

## Out of scope

- `/crew resume`, `/crew stop`, `/crew clean`, and the `checkpoint` and
  `consult` tools. Those are s04, owned by blanche-worker-1 in `lifecycle.ts`.
  Call `registerLifecycle(pi, deps)` from `index.ts` and move on — the file
  lands independently, exactly like s01 did.
- `config.ts`, `board.ts`, `handoff.ts` (worker-1), and the s01/s02 test files.
- Parallel workers. `maxWorkers: 1`.

## Dependencies

s01 (`loadConfig`, `resolveCrew`, `createTask`, `readBoard`, `commitBoard`,
`decideHandoff`), s02 (`buildCrewBlock`, `spawnRole`).

## Expected write scope

```
index.ts
test/receive.test.ts
```

## Implementation notes

### Registration

```ts
export default function (pi) { ... }
```

- `before_agent_start` — when `BLANCHE_ROLE` and `BLANCHE_TASK` are set, read
  the board, read role prompt / spec body / latest checkpoint / latest
  consultation from disk, and **return** `{ systemPrompt: buildCrewBlock(...) }`.
  index.ts does every file read; `buildCrewBlock` stays pure.
- `session_compact` — `sessions[role].contextEpoch++`, commit. Fires on
  `manual`, `threshold` and `overflow`; all three count.
- Status bar via `ctx.ui.setStatus("blanche", ...)`.

### Commands (this spec)

**`index.ts` owns the single `/crew` command registration.** `lifecycle.ts` does
not register a command; it returns `handleAction(action, idArg, ctx)`, and this
file delegates any action it does not handle itself. Registering `"crew"` from
both files means one registration silently loses — found by running the
extension for real: index won, so every lifecycle command was unreachable while
48 unit tests stayed green. Unit tests cannot see this, because a test that
calls `registerLifecycle` in isolation has nothing to collide with.

Also note `registerLifecycle` is currently called from the channel's `onReady`
callback, which fires after this file's synchronous registration — so delegation
must not depend on lifecycle having been wired at load time.

- `/crew <workflow> "<description>"` — resolve the crew, `createTask`, write
  `task.md`, spawn every roster role with `spawnRole`, record `sessionName` and
  `paneId` per role, commit, and report the roster.
- `/crew status` — phase, owner, current spec, rework, per-role epoch and
  liveness.

Both must fail loudly rather than half-succeed: if the broker is unreachable or
a pane fails to register, close what was opened and say what happened.

### handoff tool

Params: `to`, `phase`, `spec?`, `message`, `verdict?`.

1. Read the board, get live session names from the intercom roster.
2. `decideHandoff(...)` — s01 owns every rule; do not re-implement any of it.
3. Not ok → return the error verbatim as a tool error. Nothing is committed.
4. ok → `commitBoard(next, expectedRevision)`; on a stale revision, re-read and
   retry once, then fail.
5. `channel.publish({ taskId, handoffId, to, phase, message, verdict, notes })`.
6. Return the delivered message plus `decision.notes` so the sender sees the
   advisor nudge and any missing-checkpoint warning.

### Receiving side — the part that was missing

Extract the decision as a pure function so it can be tested without a broker:

```ts
export function shouldDeliver(input: {
  payload: { taskId: string; handoffId: string; to: Role };
  myTaskId: string; myRole: Role; seenHandoffIds: string[];
}): boolean
```

On a channel message: `shouldDeliver` → false means ignore silently. True means
stamp `ackedAt` on the matching `history` entry, commit, and call
`pi.sendMessage(..., { triggerTurn: true })`.

Deliver only when the payload's `taskId` matches this session's task **and** its
`to` matches this session's role **and** the `handoffId` has not been seen. All
three matter: the channel is broadcast, two crews can run at once, and
`/crew resume` deliberately republishes an unacked handoff, so the same id will
legitimately arrive twice.

## Acceptance criteria

- `/crew quick "..."` spawns worker and qa panes and reports them.
- A `handoff` from one live session starts a turn in the target session.
- A handoff rejected by `decideHandoff` commits nothing.
- `shouldDeliver` is pure and total; unknown payload shapes return false rather
  than throwing.
- Injection still returns `{ systemPrompt }` and never enters history.

## Test cases

### Happy path
- `shouldDeliver` true for matching taskId + role + unseen handoffId.

### Failure cases
- Wrong `taskId` → false. Wrong `to` role → false. Malformed payload → false,
  no throw.

### Edge cases
- Repeated `handoffId` → false the second time (this is the resume-republish
  path, so it must dedupe rather than double-deliver).
- Empty `seenHandoffIds` → true.

### Regression
- A `handoff` whose `decideHandoff` returns `ok: false` leaves `board.json`
  byte-identical.

### Proved by smoke, not unit tests
Kickoff, spawning, status and the real turn-trigger. Extend `test/smoke.sh`; do
not build a pi mock.
