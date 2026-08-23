# Spec s04 — Lifecycle: resume, stop, clean, checkpoint, consult

Owner: blanche-worker-1 (after s01 `listTasks` is green)

## Why this spec exists

The other half of the s02 split. s03 makes a crew you can start and hand off
inside; this makes one you can leave and come back to. Durability is the design's
headline claim — "if every transcript disappeared, could `/crew resume`
reconstruct enough truth?" — and it is entirely in this spec.

## Goal

A crew that survives a restart, and roles that leave durable state behind
instead of leaving it in a transcript.

## Scope

- `lifecycle.ts`, exporting one entry point:

```ts
export function registerLifecycle(pi: any, deps: {
  channel: () => IntercomChannel | undefined;
  liveSessions: () => Promise<string[]>;
}): void
```

  `index.ts` (s03, worker-2) calls this once. That single call site is the only
  coupling between us, so neither of us edits the other's file.

- `test/lifecycle.test.ts`.

## Out of scope

- `index.ts` — worker-2 owns it. If you need something from it, ask; do not edit.
- `config.ts`, `board.ts`, `handoff.ts` are yours from s01, but this spec should
  not need to change them. If it does, say so before you do it.
- Archiving or purging task history. `/crew clean` deletes, full stop.

## Dependencies

s01 (`readBoard`, `writeBoard`, `commitBoard`, `listTasks`, `writeCheckpoint`,
`writeConsultation`, `taskDir`), s02 (`spawnRole`).

## Expected write scope

```
lifecycle.ts
test/lifecycle.test.ts
```

## Implementation notes

### `/crew resume [id]`

The important one. Steps, in order:

1. Resolve the task: explicit id, else the most recent task in this cwd —
   `listTasks(process.cwd())[0]`, which is exactly why s01 sorts by mtime.
2. Replay `board.resolved` verbatim. Never re-resolve from `pi-blanche.json`:
   the config may have changed since kickoff, and a resumed task must be the
   task it was. `configRevision` records the drift; do not act on it.
3. For each roster role, keep the session if its name is live, else `spawnRole`
   it again and update `sessionName`/`paneId`.
4. `status: "active"`, commit.
5. Republish the last `history` entry if it has no `ackedAt`. s03's
   `shouldDeliver` dedupes on `handoffId`, so a republish that was in fact
   delivered is harmless — which is why republishing unconditionally is wrong
   and republishing only unacked entries is right.

### `/crew stop`

`status: "stopped"`, commit. Do not touch `phase`, `owner`, panes or files. A
stop in QA must resume in QA — the whole point of `status` being a separate
field from `phase`.

### `/crew clean [id]`

Close every recorded `paneId`, delete the task directory, drop the crew's
channel state. Never inspect git, never refuse on a dirty tree: the happy path
leaves a dirty tree by design, and this command owns pi-blanche's state, not
yours.

### `checkpoint` tool

Params match `CheckpointInput`. Writes via `writeCheckpoint` at
`checkpoints/{spec|task}-{role}-e{epoch}.md`, sets
`sessions[role].latestCheckpoint`, commits.

### `consult` tool

Params: `role` (`researcher` | `advisor`), `question`, `context?`.

Publishes the question and, when the answer returns, writes
`consultations/c-*.md` with the distilled conclusion, appends a
`ConsultationRecord` carrying `requestedBy`, `spec` and the current
`reworkRound`, sets `lastAdvisorConsultedRound`, commits.

**A consultation must never move `phase` or `owner`.** The asker stays the owner
while it waits. This is the single most important invariant in the file —
s01's advisor nudge fires on every rework round until `lastAdvisorConsultedRound`
covers the round, so this is what turns the nudge off.

## Acceptance criteria

- `resume` replays the persisted `resolved` snapshot even when
  `pi-blanche.json` has changed since kickoff.
- `resume` respawns only missing roles and leaves live ones untouched.
- `resume` republishes an unacked handoff, and does not republish an acked one.
- `stop` then `resume` returns to the same phase, owner and spec.
- `clean` runs on a dirty tree without complaint and touches nothing git owns.
- `consult` leaves `phase` and `owner` unchanged and sets
  `lastAdvisorConsultedRound`.

## Test cases

### Happy path
- `resume` on a board whose sessions are all live spawns nothing.
- `checkpoint` writes the file, sets `latestCheckpoint`, bumps revision once.

### Failure cases
- `resume` with an unknown id errors naming the ids that exist.
- `clean` on an unknown id errors without deleting anything.

### Edge cases
- `resume` after the config file changed uses the persisted `resolved`, not the
  new config.
- `resume` with the last handoff already acked republishes nothing.
- `stop` on an already-stopped task is a no-op, not an error.

### Regression
- `consult` leaves `phase`, `owner` and `currentSpec` deep-equal to before.
- `clean` deletes the task directory and nothing outside it.
