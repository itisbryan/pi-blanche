[Index](architecture.md)

# 4. Crew

## 4.1 Capability allocation

Reasoning budget is allocated to **decisions**, not uniformly across agents.

| Role | Thinking | Owns phases | Function |
|---|---|---|---|
| leader | operator | yes | requirement, plan review, architecture, final escalation |
| planner | `high` | yes | decomposition into independently verifiable specs |
| researcher | `medium` | **no** | gathers facts; read-only |
| advisor | `xhigh` | **no** | reasons about *why* attempts failed |
| worker | `low` | yes | executes one approved spec |
| qa | `low` | yes | authors tests, runs validation, `PASS｜FAIL` |
| verifier | `high` | yes | architecture, security, data integrity, `APPROVED｜CHANGES` |

The arithmetic is the point. A worker runs many turns; a verifier runs few. A
uniform `high` allocation spends the majority of the budget on the role that
does the most mechanical work. Allocating `low` to the worker and `xhigh` to an
advisor consulted only on escalation inverts that, and makes the expensive
reasoning conditional on evidence that it is needed.

### Service roles

`researcher` and `advisor` own no phase. This is derived, not configured: a role
present in a workflow's roster that appears as the owner of no phase **is** a
service role. Consequences:

- They are reached by ordinary `intercom` messages, not handoffs.
- Consulting one never moves `phase` or `owner`; the asker remains owner while
  it waits.
- They cannot block progress, because progress is not defined in terms of them.

#### Spawn timing

The **advisor is spawned on demand**, not at kickoff — when a handoff targets it,
or when the `advisorAfter` directive first fires. Measured before the change:
`consultations = 0` across every task ever run, while the advisor sat in six of
seven rosters costing a pane, a model and a registration wait on every kickoff.
`investigate` now spawns one pane instead of two.

The trade is real and worth naming: the first escalation pays a spawn plus a
registration wait, inside a path that is already slow.

The **researcher stays eager**, and the asymmetry is deliberate. Agents reach it
with a plain `intercom` message, which the extension does not mediate — so there
is no trigger to hook. Spawning it lazily would advertise a peer name with no
session behind it, which is the confident-wrong-value failure this codebase has
hit repeatedly ([§7.2](verification.md#72-three-defects-that-passed-a-green-suite)).
Relatedly, the injected peer list contains only roles that currently have a
session: an agent is never handed a name it cannot reach.

### Why retrieval and inference are separate roles

Conflating them forces one of two bad outcomes: an expensive agent performing
cheap lookups, or a cheap agent performing expensive reasoning.

| | researcher | advisor |
|---|---|---|
| Question | *"Where is X implemented? What calls Y?"* | *"Why did three attempts at X fail?"* |
| Input | the codebase, the web | a **packet**: goal, spec, acceptance, diff, failed attempts, qa evidence, current hypothesis |
| Output | distilled findings | diagnosis + recommended approach + what not to change |
| Cost profile | frequent, cheap | rare, expensive |

The advisor receives a *packet*, never a transcript. This is what keeps an
`xhigh` consultation bounded: the input is assembled from durable state and the
qa failure evidence, so its size is a function of the spec rather than of how
long the worker has been struggling.

The researcher's contract is symmetrical in the other direction: it returns
distilled findings rather than raw dumps, so that the *asker's* context stays
small. A researcher that pasted a 400-line file into a reply would defeat the
purpose of asking rather than reading.

## 4.2 Workflows as task shapes

Seven workflows. Each declares a prefix, a roster, an ordered phase list with an
owner per phase, and the escalation bounds.

| Workflow | Roster | Phases | `advisorAfter` / `maxRework` |
|---|---|---|---|
| `quick` | worker, qa | IMPLEMENTING → QA | — / 2 |
| `fix` | researcher, advisor, worker, qa, verifier | REPRODUCE → DIAGNOSE → IMPLEMENTING → QA → VERIFY | 2 / 4 |
| `hotfix` | advisor, worker, qa | TRIAGE → IMPLEMENTING → TARGETED_QA → LEADER_REVIEW | 1 / 2 |
| `feat` | full crew | DISCOVERY → PLANNING → PLAN_REVIEW → IMPLEMENTING → QA → VERIFY | 2 / 3 |
| `refactor` | planner, advisor, worker, qa, verifier | BASELINE → PLANNING → IMPLEMENTING → REGRESSION_QA → VERIFY | 2 / 3 |
| `investigate` | researcher, advisor | INVESTIGATING → REPORT | — / 0 |
| `review` | qa, verifier, advisor | QA → VERIFY | — / 0 |

Each phase list is bracketed by `REQUESTED` (or `TRIAGE`) and `DONE`, both owned
by the leader.

Three of these are shaped by a specific need:

- **`fix` has `REPRODUCE` and `DIAGNOSE` before `IMPLEMENTING`.** A bug that is
  not demonstrated is not understood. The worker's contract is to produce a
  failing test, request, log or query result, and to state a root cause, before
  changing anything.
- **`refactor` has `BASELINE` owned by qa**, before planning. Behaviour-
  preservation cannot be checked without a record of the prior behaviour.
- **`investigate` has no implementation role at all.** Its output is a report:
  *Finding / Evidence / Likely root cause / Confidence / Suggested fix / Files /
  Risks*. `maxWorkers: 0`.

### Why there is no risk axis

An orthogonal `--risk low|medium|high` dimension was specified, implemented as a
roster modifier, and then removed.

**The failure.** Risk as a global add/drop of roles produces incoherent
combinations. `--risk high` on `quick` added a `planner` to a workflow whose
phase list contains no `PLANNING` phase: a role with nothing to own, unable to
act, and unreachable as a handoff destination.

**The proposed repair, and why it was declined.** The fix would have been
per-workflow risk overlays with `appendPhases` / `insertBefore` — that is, a
small language for composing phase lists. That is a larger construct than the
seven presets it generalises.

**The resolution.** A workflow *is* a task shape and carries the ceremony that
shape requires. Risk is already expressed:

- a high-risk `quick` **is** a `fix`;
- a low-risk `fix` **is** a `quick`;
- a heavily-planned `fix` **is** a `feat`.

Note the rationale that was *rejected* along the way: "promote a risky bug to
`feat`". That is wrong — a high-risk production bug is still a bug and still
needs `REPRODUCE` and `DIAGNOSE`, which `feat` does not have. Promoting it would
discard exactly the phases that matter. The correct framing is task shape, not
severity.

If daily use reveals a repeated need for a shape none of the seven cover, the
answer is to add a workflow on evidence — not an axis on speculation.

## 4.3 Specs

Spec-driven workflows (`feat`, `refactor`) decompose the requirement before
implementation. `quick`, `fix` and `hotfix` are single coherent units and do
not.

### Sizing

The heuristic is cohesion and independent verifiability, never line counts:

> If the worker cannot state the spec's goal, its implementation boundary, and
> its proof of completion in a short continuation packet, it is too large.

This is deliberately the same criterion as a checkpoint's contents. A spec that
cannot be checkpointed compactly cannot be resumed compactly.

### Format

```markdown
# Spec s02 — Audit Row Serializer

## Goal
Convert Audit records into the export row schema.

## Scope / Out of Scope
serializer only; no controller, no job changes

## Dependencies            s01
## Parallel Safety         parallel_safe: true
## Expected Write Scope
app/serializers/audit_export_serializer.rb
spec/serializers/audit_export_serializer_spec.rb

## Acceptance Criteria
expected headers emitted; null actor handled; agreed timezone;
existing audit reads unchanged

## Test Cases
### Happy Path / Failure Cases / Edge Cases / Regression Cases
```

`Dependencies`, `Parallel Safety` and `Expected Write Scope` are recorded but
**not scheduled** — `maxWorkers: 1` everywhere. They are grooming output a human
wants to read, and they are the shape a future scheduler would consume. Writing
them costs nothing now; retrofitting them onto specs written without them would.

`Expected Write Scope` has a second, present-day use: it is what makes the
attribution rule in [5.5](handoff.md#55-escalation) decidable — whether a
failure belongs to the spec under review or to another.

### Grooming

The planner drafts specs and **grooms test cases with qa before** handing the
plan to the leader for `PLAN_REVIEW`. This is ordinary intercom traffic during
the planner's `PLANNING` phase: no extra phase, no extra transition, no code.

Two things fall out:

1. qa flags specs too broad to validate cleanly *before* anyone implements them,
   which is the cheapest possible moment to split one.
2. The acceptance criteria the worker builds against are the same ones qa will
   run. Divergence between "what was built" and "what was checked" is removed by
   construction rather than by review.

qa also **authors the test files** — see
[7.3](verification.md#73-why-qa-owns-the-tests) for the empirical reason.

