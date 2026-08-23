# Spec s01 — Pure core: config, board, handoff

Owner: blanche-worker-1

## Goal

The parts of pi-blanche that need no pi runtime: load and resolve config, own
the task directory, and decide handoffs. Pure functions and plain fs, so all of
it is testable with `node --test` and no pi process.

## Scope

- `config.ts` — load `~/.pi/agent/pi-blanche.json`, validate, resolve a workflow
  into `ResolvedCrew`.
- `board.ts` — task directory I/O: create, read, write `board.json`, append
  history, write checkpoint and consultation markdown files.
- `handoff.ts` — the `decideHandoff` reducer.
- `test/config.test.ts`, `test/board.test.ts`, `test/handoff.test.ts`.

## Out of scope

- Anything importing `@earendil-works/pi-*`. No pi API, no herdr, no intercom.
- `index.ts`, `spawn.ts`, `inject.ts`, `roles/*.md` — those are s02.
- Do not edit `types.ts`. If the contract is wrong, message blanche-advisor.

## Dependencies

`types.ts` (already written).

## Parallel safety

parallel_safe: true — no file overlap with s02.

## Expected write scope

```
config.ts
board.ts
handoff.ts
test/config.test.ts
test/board.test.ts
test/handoff.test.ts
```

## Implementation notes

### config.ts

```ts
export const DEFAULT_CONFIG_PATH: string          // ~/.pi/agent/pi-blanche.json
export function loadConfig(path?: string): BlancheConfig
export function resolveCrew(cfg: BlancheConfig, workflow: string): ResolvedCrew
export function phaseOwner(crew: ResolvedCrew, phase: string): Role | undefined
```

- Unknown workflow → throw naming the workflows that do exist.
- `resolveCrew` merges `workflows[w].agents` over top-level `agents`, keeps only
  roster roles, and sets `configRevision` to a sha256 of the raw config text.
- A role in `roles` that owns no phase is a service role. Expose
  `serviceRoles(crew): Role[]` — derived, never configured.
- Ship the seven default workflows from the design doc as `DEFAULT_CONFIG`, used
  when the file is absent. Write the file on first use.

### board.ts

```ts
export function taskDir(id: string): string       // ~/.pi/agent/pi-blanche/tasks/<id>
export function createTask(input: {...}): Board   // makes dirs, task.md, board.json
export function readBoard(id: string): Board
export function writeBoard(board: Board): void    // revision++, atomic write
export function listTasks(cwd?: string): Board[]  // newest first, optional cwd filter
export function writeCheckpoint(board, role, spec, epoch, input: CheckpointInput): string
export function writeConsultation(board, rec, body): string
```

- Atomic write means write to `board.json.tmp` then rename. A half-written board
  is the one file that must never exist.
- `writeBoard` bumps `revision`. Callers that hold a stale revision must lose:
  export `commitBoard(next: Board, expectedRevision: number)` returning
  `{ ok: true } | { ok: false; current: Board }`.
- Checkpoint path is `checkpoints/{spec|task}-{role}-e{epoch}.md`, rendered with
  the sections from the design doc, skipping empty ones.

### handoff.ts

```ts
export function decideHandoff(input: HandoffInput): HandoffDecision
```

Pure. No fs, no clock — `now` and `handoffId` arrive in the input. Order:

1. `to === "leader"` → target is `board.leader.sessionName`. Otherwise target is
   `board.sessions[to]?.sessionName`; not in `resolved.roster` → error listing
   the roster.
2. Target not in `liveSessions` → error naming it.
3. Verdict validation by `from`: `qa` → `PASS|FAIL`, `verifier` →
   `APPROVED|CHANGES`, anyone else → must be null/undefined. Wrong value → error
   naming the allowed set.
4. `verdict` is `FAIL` or `CHANGES` and `to === "worker"` → increment
   `reworkRound` on the spec (`board.specs[spec]`) when `resolved.specs`, else on
   the board.
5. `advisorAfter !== null`, `advisor` in roster, `reworkRound >= advisorAfter`,
   `lastAdvisorConsultedRound < reworkRound` → push the advisor nudge note.
   Must fire on every qualifying round, not once.
6. `reworkRound > maxRework` → error telling the caller to hand to the leader.
7. No checkpoint recorded for the current epoch of `from` → push a warning note.
   Never blocks.
8. Return the next board: phase, owner, `currentSpec`, and a `HandoffRecord`
   appended to history with `ackedAt` unset.

## Acceptance criteria

- `decideHandoff` never touches fs or `Date.now()`.
- A rejected handoff returns the board unchanged (no partial mutation).
- Rework is counted per spec when `specs: true`, per board otherwise.
- `commitBoard` rejects a stale revision and returns the current board.

## Test cases

### Happy path
- `resolveCrew(cfg, "feat")` returns the 6-role roster, 8 phases, `specs: true`.
- Handoff planner → leader with phase `PLAN_REVIEW` targets the leader session.
- Handoff qa → worker with `PASS` moves phase and owner, appends history.

### Failure cases
- Unknown workflow throws naming the known ones.
- Handoff to a role outside the roster errors and lists the roster.
- Handoff to a roster role whose session is not in `liveSessions` errors.
- `qa` sending `verdict: "APPROVED"` errors naming `PASS|FAIL`.
- `worker` sending any verdict errors.
- Fifth qa `FAIL` on `maxRework: 4` errors naming the leader.

### Edge cases
- `advisorAfter: null` never produces a nudge.
- `advisorAfter: 2` nudges at rework 2 **and 3**; after
  `lastAdvisorConsultedRound = 3`, rework 3 does not nudge again.
- `s02` failing twice leaves `s03.reworkRound === 0`.
- Missing checkpoint adds a note but the decision is still `ok: true`.

### Regression
- `commitBoard` with a stale revision leaves the on-disk board untouched.
- `writeBoard` interrupted mid-write leaves no partial `board.json` (simulate by
  asserting the tmp-then-rename path is used).
