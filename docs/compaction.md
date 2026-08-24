[Index](architecture.md)

# 3. Compaction

## 3.1 Non-ownership

pi-blanche does not implement, trigger, or schedule compaction.

This is a deliberate rejection of a larger design that was specified and
declined: context tracking with soft *and* hard thresholds, extension-triggered
compaction at the soft limit, blocking at the hard limit, epoch rotation with
explicit rehydration packets, and advisor-validated distillation of each epoch
before rotation.

### The elimination argument

Each component was removed by finding it already present:

**1. Context pressure is already measured.** pi-intercom publishes
`contextPct`, `contextTokens` and `contextWindow` on every session's presence
record — `/crew status` displays `58% ctx (142k/272k)` today. Re-deriving it
would duplicate a value the roster already carries, and would drift from it.

**2. Compaction is already implemented.** pi compacts at its own threshold and
emits `session_compact`. A second scheduler would not add a capability; it would
*race* the first, with two thresholds disagreeing about when to act on one
context.

**3. Rehydration is already implemented — by the injection mechanism.** Because
the block is rebuilt on every turn ([2.2](l-thread.md#22-reconstruction-not-retention)),
a session that has just compacted is re-briefed on its next turn. No rotation
handler is required, because there is nothing to rotate: the block was never
retained in the first place.

**What remains** after this elimination is small: a `checkpoint` tool, and
injecting the latest checkpoint alongside the board. Everything else was already
present in the host, or fell out of a mechanism built for a different purpose.

### Advisor-validated distillation, specifically

The rejected design also proposed passing each epoch's transcript through an
`xhigh` advisor before rotation, to produce a canonical summary.

This is a second compaction pipeline solving a problem the checkpoint schema
already addresses. The structured fields of
[2.5](l-thread.md#25-checkpoints) — particularly `failedApproaches` and
`validation` — exist precisely so that the agent that *holds* the knowledge
records it directly, rather than a second agent inferring it from a transcript.
If a checkpoint proves too thin to continue from, that is a prompt problem, not
an architecture problem, and it is fixed by changing what the worker is asked to
record.

## 3.2 Epoch accounting

`contextEpoch` for a role is incremented on pi's `session_compact` event.

Verified against source: the event is emitted **after** compaction completes, at
two call sites (`agent-session.js:1441`, `:1679`), carrying

```ts
reason: "manual" | "threshold" | "overflow"   // extensions/types.d.ts:448
```

| `reason` | Trigger | Treated as |
|---|---|---|
| `manual` | operator ran `/compact` | epoch boundary |
| `threshold` | pi's own context threshold crossed | epoch boundary |
| `overflow` | a turn overflowed and is being retried after recovery | epoch boundary |

All three increment the epoch. From the L-Thread's perspective they are
indistinguishable: each terminates an epoch, and the next turn is rebuilt from
disk regardless of why.

`overflow` is the interesting case — it fires *without* the threshold having
been crossed in an observable way, because the context was exhausted by a single
large turn rather than by accumulation. Any design that keyed epoch rotation
purely on a percentage would miss it.

## 3.3 The ordering argument

The requirement is not that a checkpoint exists at all times. It is that one
exists **before the epoch ends**.

```
        softLimit (0.65)          pi's auto-compact threshold
             │                              │
   ──────────┼──────────────────────────────┼──────────►  context usage
             │                              │
     CONTEXT_PRESSURE hint            session_compact
     → agent checkpoints              → contextEpoch++
```

`context.softLimit` (default `0.65`) is set **below** pi's threshold. When a
session's `contextPct` from the roster meets or exceeds it, the injected block
gains one line:

```
CONTEXT_PRESSURE — finish this step, then call checkpoint().
```

Since the hint fires strictly before pi's threshold, an agent that complies
checkpoints before compaction occurs.

## 3.4 Honest limits of that guarantee

**This is best-effort, and is stated as such.** Three ways it does not hold:

1. **The hint is advisory.** An agent may ignore it. Nothing enforces
   checkpointing, and nothing blocks a turn for lacking one — the handoff tool
   attaches a *warning* when the sender has no checkpoint for the current epoch,
   and proceeds.
2. **`overflow` bypasses the ordering.** A single oversized turn can exhaust the
   context without the roster ever reporting a value above `softLimit`.
3. **Roster freshness.** `contextPct` arrives via presence updates at turn
   boundaries; a long turn can move the true value substantially past the
   reported one.

Because of this, **semantic boundaries ([2.6](l-thread.md#26-checkpoint-boundaries))
are the primary mechanism and the soft limit is the backstop** — not the other
way round. A worker that checkpoints after every qa failure is protected
regardless of what the percentage says.

An earlier draft of this document asserted that a checkpoint "always exists
before pi compacts". That claim was withdrawn as unprovable; the three cases
above are why.

## 3.5 What compaction costs when it catches us

If an epoch ends with no checkpoint, the loss is bounded but real: everything
since the last checkpoint or handoff that was not written down. The board still
holds phase, owner, spec, rework count and full handoff history; the spec, plan
and requirement are intact. What is lost is the *working state* of the current
attempt — which files were being edited, what was just tried, what had just
failed.

This is precisely the content of `failedApproaches` and `currentFailures`, which
is why those two fields carry the most weight in the schema.

