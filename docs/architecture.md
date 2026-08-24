# pi-blanche — design documentation

**Version 0.1.0 · pi 0.84.2 · herdr 0.8.2**

## Abstract

A coding task frequently outlives the context window of any single agent session
working on it. Conventional mitigations — larger windows, summarising compaction
— reduce the frequency of loss without changing its character: the information
is still held in a conversation transcript, and a transcript is a lossy,
unaddressable store.

pi-blanche inverts the relationship. The task is the durable object, persisted
as files on disk; agent contexts are treated as disposable, replaceable workers
over that object. A context that is compacted, crashed, or deliberately
destroyed is not a loss event, because it held no authoritative state.

## Design principles

> **Use expensive intelligence to decide; use cheap agents to execute; escalate
> instead of making every agent expensive.**

> **Long-lived tasks, short-lived contexts.**

The first governs the crew (§4–5), the second the L-Thread (§2–3).

## Reading order

| Section | Answers |
|---|---|
| §1 [The model](model.md) | What problem is being solved, what state exists, what may be destroyed |
| §2 [L-Thread](l-thread.md) | How work continues across contexts that keep dying |
| §3 [Compaction](compaction.md) | Why the system deliberately does *not* own compaction |
| §4 [Crew](crew.md) | Which agents exist, at what cost, and how a workflow is shaped |
| §5 [Handoff protocol](handoff.md) | How the task advances, and how a stuck loop terminates |
| §6 [Consistency](consistency.md) | How concurrent processes mutate one board without losing writes |
| §7 [Verification](verification.md) | What is proven, what is not, and what a green suite failed to catch |

§§1→2→3 give the durability argument; §§1→4→5 the coordination argument. §7
 stands alone: it records three defects that passed a fully green test suite, and
the generalisations they support.

## Glossary

| Term | Meaning |
|---|---|
| **Task** (T) | A unit of work with a durable directory. Lives days. |
| **Board** | `board.json` — authoritative runtime state of T. |
| **Role** (R) | leader, planner, researcher, advisor, worker, qa, verifier. |
| **Session** (S) | One OS process running one pi agent for one role. Lives hours. |
| **Epoch** (E) | A maximal interval of a session between compactions. Lives minutes. |
| **L-Thread** | The logical thread of work for one role across all its epochs. |
| **Checkpoint** | Durable continuation state written by a role at an epoch or semantic boundary. |
| **Spec** | A small, independently verifiable unit of a task. |
| **Handoff** | The only operation that advances the task. |
| **Phase** | A named stage of a workflow, each with exactly one owning role. |

## Invariants

Stated where they are established, collected here for reference.

| | Invariant | Established in |
|---|---|---|
| **I1** | No fact required to continue T is stored only in volatile state. | [§1.4](model.md#14-state-partition) |
| **I2** | The phase, spec and checkpoint an agent reads are current as of its turn. | [§2.3](l-thread.md#23-ephemerality-of-the-injected-block) |
| **I3** | A rejected handoff leaves the board byte-identical. | [§5.3](handoff.md#53-decision-order) |
| **I4** | Every board mutation is serialised and reads fresh state inside the lock. | [§6.2](consistency.md#62-one-mutation-primitive) |

## Source map

| Concern | File |
|---|---|
| Config resolution, workflow presets | `config.ts` |
| Task directory, board, locking, checkpoints | `board.ts` |
| Handoff decision (pure reducer) | `handoff.ts` |
| Prompt block assembly (pure) | `inject.ts` |
| Extension wiring, kickoff, handoff tool, delivery | `index.ts` |
| Resume, stop, clean, checkpoint, consult | `lifecycle.ts` |
| Pane spawning, registration polling | `spawn.ts` |
