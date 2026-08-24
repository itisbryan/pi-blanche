[Index](architecture.md)

# 6. Consistency

## 6.1 The board is the only mutable shared resource

Several OS processes mutate `board.json` concurrently:

| Writer | Trigger | Fields touched |
|---|---|---|
| sender | handoff commit | `phase`, `owner`, `currentSpec`, `history`, rework counters |
| receiver | handoff delivery | `history[].ackedAt` |
| any role | `checkpoint()` | `sessions[role].latestCheckpoint` |
| any session | `session_compact` | `sessions[role].contextEpoch` |
| advisor | `consult()` | `consultations`, `lastAdvisorConsultedRound` |
| operator | `resume` / `stop` | `status`, `sessions[*]` |

**These are not causally ordered.** A worker recording a checkpoint and qa
committing a handoff are separate processes with no relationship between them.
The collision is not hypothetical: it is the ordinary case whenever two crew
members are active.

Without serialisation the failure is a lost update, and it is silent. Each
writer rewrites the *whole* document from a value it read earlier, so a
checkpoint write from a stale read can erase a concurrently committed handoff —
its history entry, its `ackedAt`, its rework increment — leaving the board
claiming the wrong owner and phase with no error anywhere.

## 6.2 One mutation primitive

```ts
export function updateBoard(id: string, mutate: (b: Board) => void): Board {
  const lock = join(taskDir(id), "board.json.lock");
  const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  for (let i = 0; i < 20; i++) {
    try {
      // ponytail: stale-break races — two processes recovering from one crashed
      // holder can both rmSync then both mkdir. Upgrade path: O_EXCL lock file
      // holding the owner pid, verified before breaking.
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 5000)
        rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
    } catch {
      sleep();
      continue;
    }
    try {
      const b = readBoard(id);
      mutate(b);
      writeBoard(b);
      return b;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error("Board is busy; retry");
}
```

`writeBoard` is not exported for general use. `mkdirSync` is the mutex: it is
atomic on every platform of interest and fails `EEXIST` when the directory
exists, which is the classic lock primitive available from the standard library
with no dependency.

> **I4.** Every board mutation is serialised and reads fresh state inside the
> lock.

### Three deliberate properties

**1. The read is inside the lock.** This is the half that actually prevents the
lost update. Mutual exclusion around a mutation of a value read *earlier* still
writes stale data — it serialises the writes without serialising the
read-modify-write, which is the operation that must be atomic.

**2. No caller supplies an expected revision.** An earlier primitive was a
compare-and-set: `commitBoard(next, expectedRevision)`. It required every call
site to pass the correct revision, and that discipline failed — silently, and in
the code paths nobody re-checked. `updateBoard` takes a callback instead, so
there is no revision to pass and therefore none to pass wrongly.

> **Making the correct operation the only operation removed the class.**

The same reasoning retired `writeBoard` from the public surface. A second way to
mutate the board is a second way to bypass the lock, and it will be used.

**3. The retry catch is narrow.** Only lock acquisition is retried. Errors from
`readBoard`, `mutate` or `writeBoard` propagate unchanged.

This one was learned the hard way. The original loop wrapped the whole critical
section in the retry catch. Because the handoff decision is computed *inside*
the mutate callback ([5.4](handoff.md#54-delivery-and-acknowledgement)), a
legitimately rejected handoff threw from `mutate` — and `updateBoard` mistook it
for lock contention, retried it twenty times, and reported `Board is busy;
retry`. A verdict-validation failure surfaced as a lock error, and the real
reason was destroyed.

The diagnostic cost of that is worse than the functional cost: it sends the next
person debugging locks when the actual problem is a verdict.

### Atomic write

`writeBoard` writes to `board.json.tmp` and renames. `rename(2)` is atomic
within a filesystem, so a reader never observes a partially written board —
either the old one or the new one, never a truncated file.

The corresponding test asserts the **observable** contract: after a write, no
`.tmp` remains and the board parses. It deliberately does not assert that
tmp-then-rename was the mechanism, because that tests the implementation path
rather than the behaviour — and rename atomicity is the filesystem's guarantee,
not something this code should be re-proving.

## 6.3 Known ceiling

> **The stale-break itself races.** Two processes that both observe the same
> lock as older than 5 s can both remove it and both acquire. Requires a crash
> *and* simultaneous recovery.

Accepted for v1, and recorded **in the source at the point of the compromise**,
not only in this document — a ceiling documented only in prose is a ceiling
nobody sees while editing the function.

Upgrade path: an `O_EXCL` lock file carrying the owner's pid, verified live
before breaking.

### Alternatives considered

| Approach | Why not |
|---|---|
| Read-after-write with a writer nonce | If A re-reads before B writes, A believes it won and B clobbers it. Shrinks the window; the lost update survives. |
| `O_EXCL` marker named for the target revision | A true CAS, but a process that creates the marker and dies **wedges every future commit at that revision permanently**. Trades a rare race for a permanent deadlock. |
| `proper-lockfile` or similar | A dependency for a dozen lines of standard library. |

The 5 s stale-break exists precisely because the marker approach's failure mode
— unrecoverable without manual intervention — is worse than the race it removes.

## 6.4 Config snapshotting

`resume` replays `board.resolved` **verbatim** and never re-resolves from
`pi-blanche.json`. The config may have changed since kickoff; a resumed task
must be the task it was, not a hybrid.

`configRevision` — a sha256 of the **raw config text**, not a re-serialisation —
records the drift without acting on it. Hashing the raw text matters: a
re-serialised hash would report "no change" for a file whose formatting or key
order changed, which is a weaker statement than the one being made.

## 6.5 Failure modes

| Condition | Detection | Response |
|---|---|---|
| Target session gone | liveness check pre-commit | reject; board never names an unreachable owner |
| Published, never injected | `ackedAt` absent | reported by `status`; `resume` republishes |
| Duplicate delivery | `handoffId` in seen set | suppressed |
| Broker unavailable | connection failure | kickoff refuses rather than spawning a mute crew |
| Concurrent commits | lock | serialised; no lost update |
| Crashed lock holder | mtime > 5 s | broken (see 6.3) |
| Partial write | tmp + rename | never observed |
| Non-converging worker | rework counter | advisor directive, then refusal to leader |
| Context exhaustion | roster `contextPct` ≥ `softLimit` | checkpoint hint; epoch rotates; block rehydrates |
| Config changed mid-task | persisted `resolved` snapshot | replayed verbatim; drift recorded |
| Operator restart | — | `resume` respawns missing roles from the snapshot |
| Partial kickoff failure | tracked pane ids | opened panes closed before reporting |

