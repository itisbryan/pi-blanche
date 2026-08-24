# Mixed Herdr crew pane layout

Status: proposed design, awaiting final user approval

## Goal

Replace pi-blanche's repeated right-only pane splits with a predictable mixed
layout that keeps the user's leader pane dominant and groups crew roles into two
horizontal stacks beside it.

The layout is supervision-oriented:

- **You · leader** remains the largest pane and keeps focus.
- Researcher, worker, and QA share the execution stack.
- Planner, advisor, and verifier share the review stack.
- Lazy roles do not consume empty placeholder panes.
- A late advisor triggers one process-preserving reflow.

## Current problem

`spawnRole` currently creates every role with:

```text
herdr pane split --current --direction right
```

The command has three structural defects:

1. every split is vertical, producing progressively narrower columns;
2. `--current` makes placement depend on focus rather than task-owned pane IDs;
3. roles have no stable spatial meaning, so researcher, worker, QA, advisor, and
   verifier are visually interchangeable.

Herdr supports the required primitives:

- `pane split --direction right|down --ratio ...`;
- explicit `--pane`/pane ID targets;
- `pane move --target-pane ... --split right|down --ratio ...`;
- `pane resize`;
- `pane layout` with pane rectangles and split ratios;
- `--no-focus` on mutating placement commands.

## Chosen topology

The layout is scoped to the rectangle occupied by the leader pane at crew
kickoff. Unrelated panes elsewhere in the tab are outside this task-owned region.

When both role groups exist:

```text
50% YOU · LEADER     30% EXECUTION       20% REVIEW
┌───────────────────┬──────────────────┬──────────────┐
│                   │ researcher       │ planner      │
│                   ├──────────────────┼──────────────┤
│                   │ worker           │ advisor      │
│                   ├──────────────────┼──────────────┤
│                   │ QA               │ verifier     │
└───────────────────┴──────────────────┴──────────────┘
```

Role groups and vertical order are fixed:

```text
execution: researcher -> worker -> qa
review:    planner -> advisor -> verifier
```

Only roles present in the task's resolved roster and already spawned receive a
pane. Rows divide equally among the roles currently present in that stack;
heights may differ by one terminal row because of integer rounding.

### One-stack states

If only execution roles exist:

```text
70% YOU · LEADER                   30% EXECUTION
┌────────────────────────────────┬──────────────────┐
│                                │ researcher       │
│                                ├──────────────────┤
│                                │ worker           │
│                                ├──────────────────┤
│                                │ QA               │
└────────────────────────────────┴──────────────────┘
```

If only review roles exist:

```text
80% YOU · LEADER                             20% REVIEW
┌───────────────────────────────────────────┬──────────────┐
│                                           │ planner      │
│                                           ├──────────────┤
│                                           │ advisor      │
│                                           ├──────────────┤
│                                           │ verifier     │
└───────────────────────────────────────────┴──────────────┘
```

The leader temporarily absorbs the absent stack's width. No shell placeholder
is created.

## Why this topology

The leader is the human-facing control surface and terminal escalation point.
It needs enough area to read handoffs, answer questions, and supervise the crew.
The execution stack groups the roles that turn facts into tested code. The
review stack groups planning, advice, and final review.

A single crew stack was rejected because a six-role feature crew would produce
unusable rows. Separate tabs were rejected because they hide work behind tab
switching. Dynamic active-pane expansion was rejected because the layout would
jump whenever ownership changed.

## Stable sizing

Horizontal ratios are stable:

| Available groups | Leader | Execution | Review |
|---|---:|---:|---:|
| both | 50% | 30% | 20% |
| execution only | 70% | 30% | — |
| review only | 80% | — | 20% |
| no crew panes | 100% | — | — |

Within each stack, spawned rows are equal height. The active owner does not
resize. Ratios are measured from `herdr pane layout` rectangles and accept normal
one-cell rounding; the implementation does not assume that passing a ratio alone
proves the resulting geometry.

## Role availability and lazy advisor

Advisor remains lazy. Before consultation there is no advisor process and no
empty advisor pane.

If a workflow initially has only an execution stack, first advisor spawn does
this once:

1. preserve IDs and process identities for all existing panes;
2. create the advisor pane without stealing focus;
3. reflow task-owned panes from 70/30 into 50/30/20;
4. place advisor in the review stack;
5. run the advisor command and wait for registration;
6. persist the advisor session only after successful registration.

If review roles already exist, advisor is added as an equal-height row in the
existing review stack. It does not cause a horizontal reflow.

The same rules apply to any other role whose stack did not previously exist.

## Placement lifecycle

### Resolve the leader pane

Kickoff resolves the current Herdr pane before creating task layout. Prefer the
inherited `HERDR_PANE_ID`; otherwise query `herdr pane current --current` and
parse the returned pane ID. If no Herdr-managed current pane exists, refuse
before spawning or persisting a crew with an actionable error.

Persist the resolved ID in `board.leader.paneId`. Existing role pane IDs remain
in `board.sessions[role].paneId`; no separate persisted layout schema is needed
because role groups, ordering, and ratios are deterministic.

### Kickoff

1. Resolve eager roles exactly as today; advisor remains excluded until its lazy
   trigger.
2. Partition eager roles by execution/review group, independent of config array
   order.
3. Build the required columns within the leader's starting rectangle.
4. Split each column downward into equal rows in canonical role order.
5. Run each role command in its assigned pane and wait for intercom
   registration.
6. Persist session records only for successfully registered roles.
7. Keep focus on the leader throughout.

The implementation may use split, move, and resize internally. The observable
rectangle, role order, process identity, focus, and isolation are the contract;
no particular binary-tree shape is public.

### Ordinary work

Handoffs, polling, widget refresh, and phase changes do not normalize layout.
Manual resizing is respected while the crew runs.

### Late role spawn

A late role is placed into its canonical stack. If the stack did not exist,
perform one process-preserving reflow. If placement or registration fails:

- close only the newly created role pane;
- do not persist its session record;
- keep every existing process alive;
- report that `/crew resume` can retry canonical repair.

A partial visual reflow may remain after a failed move/resize; this is recoverable
layout state, not task-state corruption. Resume repairs it.

### Resume

`/crew resume` is the explicit repair boundary:

1. query Herdr for every persisted leader/role pane ID;
2. treat a missing ID as a missing role—never guess by sidebar order or geometric
   proximity;
3. respawn missing roles;
4. move only task-owned panes back into canonical columns/order;
5. restore 50/30/20, 70/30, or 80/20 ratios and equal row heights;
6. update any pane ID Herdr reports as changed by a move;
7. preserve leader focus.

Resume intentionally resets manual resizing because the user selected repair on
resume. Normal operation does not.

### Stop

`/crew stop` pauses delivery but does not change pane topology or close roles.

### Clean

`/crew clean` closes only role panes recorded by this task. The leader is never
closed. Herdr naturally returns the task-owned region to the leader. Unrelated
pane IDs and their rectangles remain outside the cleanup target set.

## Focus and isolation

Every background split/move uses `--no-focus`. Every operation targets one of:

- persisted leader pane ID;
- a pane created for this task;
- a persisted role pane ID for this task.

The implementation never uses UI-focused pane position after kickoff and never
moves or closes an unrecorded pane.

The final focus after kickoff, late spawn, resume, and failed repair must be the
leader pane that initiated the operation.

## Failure atomicity

### Kickoff

Kickoff is atomic with respect to user-visible crew state:

- track every newly created pane;
- on split, move, launch, or registration failure, close those panes in reverse
  creation order;
- remove the just-created task directory or mark no active task before returning
  the error;
- persist no partial session roster;
- leave the leader and unrelated panes alive.

The cleanup result is inspected rather than inferred from a success label.

### Late spawn and resume

Existing registered role processes are never killed to repair geometry. Record
pane and process IDs before reflow and compare after it. A failed late spawn does
not roll back by restarting existing panes.

Resume commits each respawned session only after its registration succeeds. A
failure leaves the board honest about which roles are still absent and reports
the exact pane/layout operation that failed.

## Architecture and ownership

Keep layout policy separate from process startup while reusing existing board
fields:

- a focused layout module owns role grouping, desired geometry, command planning,
  and parsing `pane layout`/move results;
- `spawn.ts` owns Herdr execution, pane creation, command launch, and registration
  waiting;
- `index.ts` kickoff owns eager-role partitioning and leader pane capture;
- `lifecycle.ts` resume/clean owns repair and closure orchestration;
- `Board.leader.paneId` and `SessionState.paneId` remain the persisted identity
  seam.

No generic tiling engine, user-configurable layout DSL, or new dependency is
introduced. Ratios and role groups are product policy, not configuration in this
slice.

Only one worker writes at a time in the shared worktree. QA owns tests; workers
implement isolated seams; verifier holds the final gate.

## Verification

### Pure and fake-Herdr tests

The fake Herdr records exact argv and returns controlled pane/layout JSON.
Required assertions:

1. no role spawn uses an implicit focused pane;
2. every placement command carries explicit pane IDs; split/move commands that
   support it also carry `--no-focus`, and resize preserves observed focus;
3. role grouping and order are correct for every default workflow;
4. both-stack geometry converges to 50/30/20 within one cell;
5. one-stack geometry converges to 70/30 or 80/20;
6. rows in each stack differ by at most one cell;
7. advisor absence creates no placeholder pane;
8. late advisor produces one review-column reflow and persists only after
   registration;
9. missing persisted pane IDs are respawned, never guessed;
10. kickoff failure leaves no created panes, active task debris, or partial
    sessions;
11. late failure keeps existing role process/pane IDs;
12. clean targets every recorded role pane and never the leader/unrelated panes;
13. focus remains leader after all paths.

### Real isolated Herdr journey

Use a named disposable Herdr test session, temporary task HOME, and unrelated
sentinel pane.

1. Record the clean leader and sentinel pane IDs, rectangles, process IDs, and
   focus.
2. Start QUICK. Observe leader 70%, execution 30%, worker over QA at equal
   heights, and leader focus.
3. Clean QUICK and verify task panes are gone and sentinel state is unchanged.
4. Start FEAT. Observe leader 50%, execution 30%, review 20%; execution order
   researcher/worker/QA and review order planner/verifier before lazy advisor.
5. Trigger advisor. Observe advisor inserted between planner and verifier with
   equal review rows and no process restart.
6. Manually resize task panes. Exercise an ordinary handoff; manual geometry
   remains.
7. Run `/crew resume`; canonical widths, row heights, and order return.
8. Close one role pane. Resume respawns it in the correct stack with a new pane
   ID while every surviving process ID remains unchanged.
9. Stop the crew; topology stays. Resume; layout repairs without duplicate panes.
10. Clean. Verify all task pane IDs are absent, leader recovers its region, focus
    is leader, sentinel pane/process/terminal content is unchanged, and temporary
    task files are removed.

### Negative controls

The verification must prove it discriminates the broken implementation:

- mutate one execution `down` split to `right`; row-geometry assertion fails;
- route QA into review; role-group assertion fails;
- remove `--no-focus`; focus assertion fails;
- replace move/reflow with process restart; process-identity assertion fails;
- target the sentinel pane; isolation assertion fails;
- skip cleanup of one created pane; exact post-clean pane set fails.

Restore every mutation byte-identically before the final verdict.

## Acceptance

A clean verdict must report:

- topology exercised for QUICK, FEAT, and late advisor;
- exact observed rectangles/ratios and row order;
- leader focus before/after each lifecycle operation;
- pane and process identity preservation through reflow/resume;
- failure/negative path and mutation performed;
- unrelated sentinel state before/after;
- task directory and pane cleanup evidence;
- any residual unproven Herdr behavior.

The feature is not accepted from command logs or model snapshots alone. Geometry,
focus, running processes, and cleanup must be observed from real Herdr state.

## Scope

Included:

- mixed right/down splits;
- stable 50/30/20 role grid;
- equal role rows;
- task-owned explicit pane targeting;
- lazy-role reflow;
- resume repair and cleanup;
- focus and unrelated-pane isolation;
- deterministic and real Herdr verification.

Explicitly excluded:

- active-owner auto-expansion;
- empty placeholder panes;
- eager advisor;
- continuous layout enforcement;
- extra tabs or workspaces;
- moving unrelated panes;
- multiple simultaneous worker sessions;
- user-configurable role groups or ratios.

## Open questions

None. The user selected You · leader as the largest pane, two role stacks,
stable 50/30/20 widths, equal rows, no advisor placeholder, one late-advisor
reflow, and repair on role spawn/resume while respecting manual resizing during
ordinary work.
