# Mixed Herdr crew pane layout

Status: proposed design, awaiting final user approval

## Goal

Replace pi-blanche's repeated right-only pane splits with a predictable mixed
layout that keeps the user's leader pane dominant and groups crew roles into two
horizontal stacks beside it.

The layout is supervision-oriented:

- **You · leader** remains the largest pane and keeps focus.
- Planner, advisor, and verifier share the review stack, next to the leader.
- Researcher, worker, and QA share the execution stack, furthest out.
- Lazy roles do not consume empty placeholder panes.
- A late advisor triggers one process-preserving reflow.

Column order is **leader | review | execution**. This is not cosmetic: every
crew column is created by splitting the leader pane, which is always a single
full-height leaf, so each split yields a full-height sibling column with no
subtree re-parenting and no restarted process. Review sits beside the leader
because planning, advice, and verification are the roles the operator converses
with most; execution runs furthest out.

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

- `pane split --direction right|down --ratio ... --no-focus` (split and move
  accept `--no-focus`; resize does not, so resize must preserve focus itself);
- explicit `--pane`/pane ID targets;
- `pane move --target-pane <leaf> --split right|down --ratio ...`;
- `pane resize --direction --amount`;
- `pane layout` reporting a binary split tree of rectangles and per-split ratios.

Herdr's tree splits a **leaf** pane. A review pane created beside one leaf of a
multi-pane execution stack would span only that leaf's height, and making a
full-height column beside an existing multi-leaf subtree would require
re-parenting that subtree — not a supported primitive. Splitting the leader leaf
sidesteps this entirely: the leader is always one full-height leaf, so the
column born from it is full height by construction. This is the whole reason the
column order is leader | review | execution.

## Chosen topology

The layout is scoped to the rectangle occupied by the leader pane at crew
kickoff. Unrelated panes elsewhere in the tab are outside this task-owned region.

When both role groups exist:

```text
50% YOU · LEADER    20% REVIEW      30% EXECUTION
┌──────────────────┬──────────────┬──────────────────┐
│                  │ planner      │ researcher       │
│                  ├──────────────┼──────────────────┤
│ YOU · LEADER     │ advisor      │ worker           │
│                  ├──────────────┼──────────────────┤
│                  │ verifier     │ QA               │
└──────────────────┴──────────────┴──────────────────┘
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

If only execution roles exist (the leader keeps the review slot's width until a
review role appears):

```text
70% YOU · LEADER                  30% EXECUTION
┌────────────────────────────────┬────────────────┐
│                                │ researcher     │
│ YOU · LEADER                   ├────────────────┤
│                                │ worker         │
│                                ├────────────────┤
│                                │ QA             │
└────────────────────────────────┴────────────────┘
```

If only review roles exist:

```text
80% YOU · LEADER                          20% REVIEW
┌─────────────────────────────────────────┬────────┐
│                                         │ planner│
│ YOU · LEADER                            ├────────┤
│                                         │ advisor│
│                                         ├────────┤
│                                         │verifier│
└─────────────────────────────────────────┴────────┘
```

The leader temporarily absorbs the absent stack's width. No shell placeholder
is created. When the missing stack later appears, it is birthed by splitting the
leader, so the present stack's column and processes are untouched.

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

Observed left-to-right order is leader | review | execution.

| Available groups | Leader | Review | Execution |
|---|---:|---:|---:|
| both | 50% | 20% | 30% |
| execution only | 70% | — | 30% |
| review only | 80% | 20% | — |
| no crew panes | 100% | — | — |

Within each stack, spawned rows are equal height. The active owner does not
resize. Ratios are measured from `herdr pane layout` rectangles and accept normal
one-cell rounding; the implementation does not assume that passing a ratio alone
proves the resulting geometry.

## Role availability and lazy advisor

Advisor remains lazy. Before consultation there is no advisor process and no
empty advisor pane.

If a workflow initially has only an execution stack (hotfix and investigate are
the only two default workflows where this happens, because advisor is their only
review role and it is lazy), the first advisor spawn does this once:

1. record IDs and process identities for the leader and every execution pane;
2. split the **leader** leaf to the right, `--no-focus`, birthing a full-height
   review column between the leader and the execution stack;
3. resize so the observed geometry is leader 50 / review 20 / execution 30;
4. run the advisor command in the new review pane and wait for registration;
5. persist the advisor session only after successful registration;
6. re-query pane IDs and confirm every prior execution process/pane is unchanged.

Step 2 is the load-bearing choice: splitting the leader leaf (never the execution
subtree) produces a full-height review column without re-parenting, so no
execution process is touched. The execution stack keeps its 30% column; only the
leader's width changes, 70 -> 50.

If review roles already exist, advisor is added as an equal-height row in the
existing review stack. It does not cause a horizontal reflow.

The same rules apply to any other role whose stack did not previously exist: the
new stack's column is always birthed by splitting the leader leaf.

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
3. Build each required column by splitting the **leader** leaf to the right
   (`--no-focus`): review first so it lands beside the leader, then execution,
   giving observed order leader | review | execution.
4. Split each column downward into equal rows in canonical role order.
5. Run each role command in its assigned pane and wait for intercom
   registration.
6. Persist session records only for successfully registered roles.
7. Keep focus on the leader throughout.

The implementation may use split, move, and resize internally. The observable
rectangle, role order, process identity, focus, and isolation are the contract;
no particular binary-tree shape is public. The one hard requirement the tree
imposes is that a new full-height column is created by splitting the leader leaf,
never by trying to re-parent an existing multi-leaf stack.

### Ordinary work

Handoffs, polling, widget refresh, and phase changes do not normalize layout.
Manual resizing is respected while the crew runs.

### Late role spawn

A late role is placed into its canonical stack. If the stack did not exist,
perform one process-preserving reflow. If placement or registration fails:

- close only the newly created role pane;
- do not persist its session record;
- keep every existing process alive;
- report that `/crew resume` can respawn the still-missing role (state repair;
  it does not re-normalize layout geometry — see §Resume).

A partial visual reflow may remain after a failed move/resize; this is recoverable
layout state, not task-state corruption. Resume repairs it.

### Resume

`/crew resume` is a STATE repair boundary, not a layout normalizer. In v1 it:

1. queries Herdr for every persisted leader/role pane ID;
2. treats a missing ID as a missing role—never guessing by sidebar order or
   geometric proximity;
3. respawns each missing role, placing its new pane by splitting the leader
   (right, 0.7) and updates the pane ID Herdr returns;
4. preserves leader focus.

**Resume does NOT normalize existing-pane geometry, order, or ratios**
(`ponytail:` v1 ceiling — resume repairs task STATE, not layout). Core resume
is deliberately decoupled from layout repair so a resume without a resolvable
Herdr pane still reactivates the task and republishes handoffs. A resumed crew
is therefore continuable and correctly owned, but its panes may not be in the
canonical leader | review | execution 50/20/30 arrangement — respawned roles are
placed by a naive leader split. Full canonical re-layout on resume (move
task-owned panes back into order, restore 50/20/30, 70/30, or 80/20 ratios and
equal rows) is a documented residual; add it when a resumed layout drifting from
canonical actually bites.

Manual resizing is not restored either, for the same reason. Normal operation
never normalizes layout.

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
4. both-stack geometry converges to leader 50 / review 20 / execution 30 within
   one cell, in that left-to-right order;
5. one-stack geometry converges to 70/30 (execution) or 80/20 (review);
6. rows in each stack differ by at most one cell;
7. advisor absence creates no placeholder pane;
8. late advisor into an existing review stack adds a row and issues NO leader
   split; late advisor with no prior review stack issues exactly one leader-leaf
   right split (CREATION) and persists only after registration — the assertion
   distinguishes column creation from row addition;
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
4. Start FEAT. Observe leader 50 / review 20 / execution 30 in that order;
   execution rows researcher/worker/QA and review rows planner/verifier before
   lazy advisor (review stack already exists at kickoff).
5. Trigger advisor. Observe advisor inserted between planner and verifier as an
   equal review row, with NO leader split and no process restart (row-addition
   path).

### Real isolated journey: hotfix/investigate late-advisor column creation

This is the load-bearing case verifier #7 requires, and the only path that
creates a review column beside an existing execution stack. Run it on hotfix
(execution = worker, QA) and, separately, investigate (execution = researcher).

a. Start the workflow. Observe leader 70 / execution 30, no review column, and
   the execution rows in canonical order; record leader and every execution
   pane/process ID.
b. Trigger the advisor consultation. Observe exactly one right split of the
   **leader** leaf, `--no-focus`.
c. Observe the resulting geometry is leader 50 / review 20 / execution 30, with
   the review column full height beside the leader and the execution column
   unchanged in width and full height.
d. Re-query pane IDs: every execution pane ID and process ID from (a) is
   unchanged; only the leader width changed and the advisor pane is new.
e. Confirm focus never left the leader.
f. On hotfix, the execution stack has two leaves; explicitly confirm the review
   column spans the full height, not just one execution leaf's height — this is
   the exact failure the leader-split avoids.
6. Manually resize task panes. Exercise an ordinary handoff; manual geometry
   remains (normal operation never normalizes layout).
7. Close one role pane. Run `/crew resume`; it respawns ONLY the missing role
   (new pane id, split from the leader) while every surviving process ID remains
   unchanged, reactivates the task, and preserves leader focus. It does NOT
   restore canonical widths/rows/order — that is the documented v1 residual in
   §Resume.
8. A resume with all roles already live respawns nothing and simply reactivates.
9. Stop the crew; topology stays. Resume adds no duplicate panes.
10. Clean. Verify all task pane IDs are absent, leader recovers its region, focus
    is leader, sentinel pane/process/terminal content is unchanged, and temporary
    task files are removed.

### Negative controls

The verification must prove it discriminates the broken implementation:

- mutate one execution `down` split to `right`; row-geometry assertion fails;
- route QA into review; role-group assertion fails;
- remove `--no-focus`; focus assertion fails;
- replace move/reflow with process restart; process-identity assertion fails;
- create the late review column by splitting an execution leaf instead of the
   leader; the full-height-column assertion (step f) fails because the column
   spans only one execution leaf;
- target the sentinel pane; isolation assertion fails;
- skip cleanup of one created pane; exact post-clean pane set fails.

Restore every mutation byte-identically before the final verdict.

## Acceptance

A clean verdict must report:

- topology exercised for QUICK, FEAT, and hotfix/investigate late-advisor column
  creation;
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
- stable leader | review | execution 50/20/30 role grid;
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
stable widths, equal rows, no advisor placeholder, one late-advisor reflow, and
repair on role spawn/resume while respecting manual resizing during ordinary
work. Column order is leader | review | execution (50/20/30) because a full-height
column is only achievable by splitting the leader leaf, not by re-parenting an
existing execution stack.
