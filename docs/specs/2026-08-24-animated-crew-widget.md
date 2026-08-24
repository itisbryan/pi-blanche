# Animated crew widget

Status: proposed design, awaiting final user approval

## Goal

Replace pi-blanche's static debug-style crew widget with a polished, passive,
animated command frame that makes workflow progress, ownership, operator
identity, provisioning, and liveness immediately legible.

The widget must remain useful in every participant pane, at narrow terminal
widths, with color disabled, and in both light and dark pi themes.

## Chosen direction

Use one connected frame with an animated workflow **title rail** and a crew
divider. The title rail carries current-to-next phase motion; it does not consume
a separate content row. The crew section keeps one stable row per configured
role. Actual handoffs temporarily animate in the same title rail, then settle
into the next phase.

Keeping animation in the title rail is structural, not decorative: the largest
default roster has six crew roles plus the leader. Top rail + divider + seven
role rows + bottom rail is exactly ten lines, the widget's hard design budget.

Wide presentation:

```text
╭─ BLANCHE · FEAT · 01 REQUESTED ─●─> 02 DISCOVERY/planner ────╮
├─ CREW · mb-mt6xeq2p ─────────────────────────────────────────┤
│ > YOU · LEADER                         owner · live          │
│   PLANNER                                      not started   │
│   RESEARCHER                                   not started   │
│   ADVISOR                                      on demand     │
│   WORKER                                       not started   │
│   QA                                           not started   │
│   VERIFIER                                     not started   │
╰──────────────────────────────────────────────────────────────╯
```

Compact presentation:

```text
╭─ QUICK · 01 REQUESTED ─●> 02 IMPL/worker ─╮
├─ CREW · quick-mt6… ───────────────────────┤
│ > YOU · LEADER              owner · live  │
│   WORKER                     not started  │
│   QA                         not started  │
╰───────────────────────────────────────────╯
```

This is a passive status surface. It has no focus, key handling, expansion,
settings, or commands.

## Why this direction

The current widget exposes facts but presents them at nearly equal weight:

```text
blanche · quick-mt6xeq2p · REQUESTED · rework 0/2
  worker       not spawned
  qa           not spawned
▸ leader       offline
```

That has produced real confusion:

- `leader` looked like another spawned agent rather than the user's operator
  session;
- ownership and liveness were easy to conflate;
- `not spawned` made an expected lazy advisor look broken;
- no next edge was visible, so legitimate same-role phase progress resembled a
  loop;
- fixed padding and static strings could only be clipped, not reflowed;
- there was no theme-aware hierarchy.

The connected frame gives workflow and crew one visual object without the
heaviness of two independent cards. Stable roster rows make state changes easy
to notice. Motion communicates ownership and transfer without replacing text.

## Rejected alternatives

### Static editorial stack

A two-line header and open roster was clear but still looked like aligned debug
output. It did not meet the requested level of visual polish or motion.

### Two separate cards

Separate WORKFLOW and CREW boxes established hierarchy, but looked disconnected
and generic. The selected connected frame retains sections through one divider.

### Horizontal dashboard strip

Packing roles into one line saved height for small crews but hid trailing roles
in six-role workflows and made state changes move unpredictably.

### Hard workflow enforcement

The UI may steer with a concrete next edge, but this change does not add phase
adjacency or recipient enforcement to `decideHandoff`. That remains outside the
v1 enforcement boundary.

## Information hierarchy

Keep information in this order when width becomes scarce:

1. workflow, task identity, and current phase;
2. current owner and concrete next owner/phase, or `final`;
3. every configured role and its explicit runtime state;
4. positive rework state;
5. current spec;
6. context percentage;
7. context epoch.

Epoch is omitted from the normal widget. It is internal recovery telemetry and
there is no debug-view requirement in this slice.

Zero rework is omitted. Positive rework is shown in the workflow title rail.
At the configured maximum it remains textual and uses the error theme token.
At or above the advisor threshold it uses warning unless the maximum has been
reached.

Context percentage is shown only when known and only when width permits. An
unknown value is omitted, never shown as `0%`.

## Viewer identity

Exactly one row is marked as the viewing session.

In the operator pane:

```text
> YOU · LEADER    owner · live
```

In a worker pane:

```text
  OPERATOR · LEADER       live
> YOU · WORKER      owner · live
```

`YOU` is derived from the same participant identity already used to decide
whether the widget renders:

- a crew pane uses `BLANCHE_ROLE`;
- the operator pane matches the persisted leader session name;
- an unrelated session gets no widget.

The label does not claim that the viewer is live. Viewer identity, ownership,
provisioning, and liveness remain independent facts.

## Role state semantics

Each row represents three independent dimensions:

1. **Viewer identity** — `YOU` appears on exactly one row.
2. **Ownership** — `>` and the literal word `owner` mark the current phase
   owner.
3. **Provisioning/liveness** — one of the explicit states below.

| Condition | Text | Theme token | Meaning |
|---|---|---|---|
| role has no session record and is lazy advisor | `on demand` | `muted` | expected lazy state |
| other role has no session record | `not started` | `dim` | not provisioned yet |
| recorded session is in broker roster | `live` | `success` | present in latest roster |
| recorded session is absent from broker roster | `offline` | `warning` | provisioned but not currently observed |

The leader is always rendered as the operator, never as advisor or a generic
crew peer. Its liveness still follows broker evidence; the UI does not silently
rewrite an absent roster entry as live.

Color reinforces but never replaces the words or owner marker.

## Workflow semantics

The renderer finds the current phase in `board.resolved.phases` and derives the
next configured phase by index.

Examples:

```text
01 REQUESTED ─●────> 02 IMPLEMENTING / worker
02 INVESTIGATING ─●> 03 REPORT / researcher
04 DONE · complete
```

The second example is deliberately same-role progress. It must read as a real
phase transition, not a stuck self-loop.

If the current phase is absent from resolved configuration, render the current
phase without a fabricated next edge. The component must not throw.

A final phase renders `complete`, stops animation, and does not suggest another
handoff. `board.status !== "active"` also stops continuous animation. This
covers `stopped`, `blocked`, and `done`; the final configured phase is treated
as settled even if older boards still say `status: active`.

## Motion language

### Active phase tracer

While the task is active, the current phase has a next phase, and the current
owner is live, a fixed-width tracer moves toward the next edge:

```text
●─────>
─●────>
──●───>
───●──>
────●─>
─────●>
```

Frames advance approximately every 180 ms. The connector width never changes.
The animation communicates that the current owner holds work; it does not claim
a completion percentage.

### Handoff transition

When the latest handoff ID changes after the widget's initial snapshot, replace
the workflow title rail for roughly 1.5 seconds with a one-shot route:

```text
╭─ HANDOFF · researcher ──●───> worker · IMPLEMENTING ─╮
```

This changes content, never height.

The destination row and CREW divider pulse with `borderAccent` during the same
window. The event plays once, then the component settles on the new phase.
Initial render never replays historical handoffs.

### State changes

While the board is active and non-final, a role whose provisioning or liveness
text changed receives a short accent pulse. The state word remains visible
throughout. A change into `stopped`, `blocked`, `done`, final, or owner-offline
state settles immediately and starts no one-shot timer.

### Settled states

Continuous timers stop when:

- the task status is not active;
- the current phase is final;
- the current owner is offline or unprovisioned;
- the widget is replaced or cleared.

`DONE` changes the workflow label to `COMPLETE`. A stopped or blocked task keeps
its explicit status visible and freezes the tracer.

### Timer lifecycle

There is one **long-lived component per mounted task/viewer**. `refreshWidget`
updates that component's semantic snapshot; it does not call `setWidget` again
for ordinary board or roster changes. This preserves in-flight transition state
and prevents each three-second poll from restarting the tracer.

The component starts its one timer only while a continuous or one-shot animation
is active. The interval is `unref()`'d so it cannot hold the process open. Each
tick calls the captured `tui.requestRender()`. Static states have no timer and
produce no render churn.

`update(snapshot)` starts, stops, or preserves animation as appropriate. A new
handoff ID starts one wall-clock transition; later liveness/context updates do
not restart it. Initial mount records the latest handoff without replaying it.

`dispose()` clears the interval and marks the component inert. Pi's host calls
`dispose()` when a widget is replaced, cleared with `setWidget(key, undefined)`,
or all extension widgets are reset. A task/viewer identity change may replace
the component; an ordinary data refresh may not.

`board.status === "stopped"` is the UI's paused state. Continuous motion stops
when status is `stopped`, `blocked`, or `done`, or when `phase === "DONE"`.
`DONE` the phase and `done` the status remain distinct conditions.

No animation library is added.

## Wrapper and theming

Use the component-factory form of `ctx.ui.setWidget`:

```ts
ctx.ui.setWidget("blanche", (tui, theme) => component)
```

The static `string[]` form is insufficient because it has no render width or
callback theme and the host caps static arrays at ten lines. The component form
is still designed to a ten-line maximum so a six-role crew plus leader retains
the bottom border under terminal height pressure. The animated workflow lives
in the top rail; it never adds an eleventh line.

The factory receives a theme, but a mounted widget is not recreated when the
user switches themes. The component therefore receives a live theme provider
from `index.ts` and resolves theme tokens during every `render(width)`. It does
not retain pre-baked ANSI strings. `invalidate()` clears only width/layout
caches; a light-to-dark toggle while mounted must immediately use the new theme.

Theme roles:

| Element | Theme role |
|---|---|
| brand, current phase, owner marker | `accent` |
| ordinary border | `borderMuted` |
| active handoff/changed divider | `borderAccent` |
| metadata and next labels | `muted` |
| live | `success` |
| offline and positive rework | `warning` |
| maximum rework | `error` |
| not started | `dim` |
| normal content | `text` |

No raw RGB or baked terminal palette is used.

## Width behavior

Every line returned by `render(width)` must satisfy
`visibleWidth(line) <= width`. Style first, then use ANSI-aware
`truncateToWidth`; never use raw string length or `slice` on styled text.

### 60 columns and wider

- one workflow rail with brand, workflow, task ID, phase, next phase, and owner;
- aligned roster state and optional context;
- positive rework and current spec when space permits.

### 40–59 columns

- compact task ID in the CREW divider;
- current phase and next edge remain in one abbreviated top rail so the maximum
  roster stays within ten lines;
- every configured role remains visible;
- context and spec metadata drop before structural information.

### 24–39 columns

- abbreviate phase metadata and state labels only as needed;
- keep every role row;
- omit task title, spec, context, and rework before truncating role identity;
- keep owner and liveness as separate textual cues.

### Below 24 columns

Render a deterministic minimal unframed fallback rather than malformed borders.
It must not throw. Lines are ANSI-safely truncated and roles remain represented
in stable order, even when labels must shorten.

Unicode box/tracer glyphs are accepted only when each has visible width one.
The renderer has an ASCII glyph set (`+|-o>`) as a fallback. Every frame in both
glyph sets has identical visible width.

## Architecture and ownership

Keep the change to the smallest useful seam:

- a focused widget module owns view-model derivation, responsive rendering,
  motion frames, `update(snapshot)`, and component disposal;
- `index.ts` owns session identity, live roster input, live theme provider, and
  mounting one component per task/viewer with `setWidget`;
- ordinary refreshes call the mounted component's `update`, not `setWidget`;
- existing board and handoff types are reused; no new persistence format is
  introduced.

Work sequence:

1. QA writes failing pure-render, identity, animation, and lifecycle tests.
2. Worker-1 implements the pure responsive component.
3. Worker-2 wires viewer identity, snapshots, and pi widget lifecycle.
4. QA runs source tests and real TUI light/dark evidence.
5. Verifier reviews the complete delta against this specification.

Only one worker writes at a time in the shared worktree.

## Scope

Included:

- connected responsive frame;
- theme-aware semantics;
- viewer/operator labeling;
- explicit phase-next progress;
- full stable roster;
- active tracer, handoff transition, and changed-row pulse;
- correct timer disposal and unchanged-snapshot behavior;
- light/dark and narrow-width verification.

Explicitly excluded:

- interactive expansion or keyboard controls;
- a settings UI or animation preference;
- strict workflow adjacency/owner enforcement;
- changes to crew spawning, handoff protocol, or board persistence;
- an epoch/debug display;
- external UI or animation dependencies.

## Acceptance

### Semantic matrix

Exercise widths `{100, 60, 40}`, rosters `{2 roles, 6 roles}`, role states
`{live, offline, not started, advisor on demand}`, owners `{leader, crew}`,
context `{known, unknown}`, and rework `{0, positive, maximum}`.

The following are pass/fail invariants across applicable cells:

1. Leader is visibly the operator, never confusable with advisor or a generic
   crew role.
2. `YOU` appears on exactly one correct row in both operator and crew panes.
3. A spawned, offline, active-owner row simultaneously shows ownership,
   provisioning by implication, and `offline`; no dimensions collapse.
4. Current phase and concrete next owner/phase, or `complete`, are visible.
5. `INVESTIGATING (researcher) -> REPORT (researcher)` reads as progress.
6. Every configured role remains visible at 40 columns, including a six-role
   roster.
7. Every framed line has visible width exactly equal to the supplied width;
   below the framing threshold every line is at most that width. No ANSI or
   glyph is cut in half.
8. With terminal styling stripped, owner and every role state remain
   distinguishable.
9. Zero rework is hidden; positive and maximum rework are textually visible and
   semantically emphasized.
10. Lazy advisor reads `on demand`, never as an error.

### Motion and lifecycle

11. All tracer frames have identical visible width.
12. Active/live/non-final state schedules one unref'd timer and requests
    renders.
13. Status `stopped`, `blocked`, or `done`, phase `DONE`, and owner-offline
    states schedule no continuous timer and no repeated `requestRender`.
14. A changed handoff ID plays one transition; initial render and unchanged or
    unrelated updates do not replay or restart it.
15. The destination row pulse settles after the transition window.
16. Replacing or clearing the widget calls `dispose()`; no timer callback or
    `requestRender` occurs afterward.
17. An unchanged three-second poll updates neither component identity nor
    animation state.
18. Ordinary board/liveness updates use `component.update`; they do not replace
    the mounted component or interrupt an in-flight handoff.

### Real UI evidence

19. Capture the connected frame at 100, 60, and 40 columns in a real pi TUI.
20. A six-role crew plus leader renders at most ten lines, keeps the bottom rail,
    and never shows a truncation marker.
21. Capture both light and dark themes, then toggle light-to-dark while the same
    widget remains mounted; critical text stays legible and colors update.
22. Capture operator and worker panes to prove `YOU` moves exactly once.
23. Capture active tracer, one handoff transition, stopped/final settled state,
    offline role, and advisor on-demand state.
24. The widget remains passive and does not steal focus or alter editor input.

### Negative controls

At least one test or mutation must prove each critical gate would catch the
broken implementation:

- raw-length truncation overflows with ANSI/Unicode;
- two rows labeled `YOU`;
- six-role roster drops a role at 40 columns;
- repeated refresh leaks or duplicates timers, or a disposed/stopped component
  still calls `requestRender`;
- an ordinary update replaces the component and resets an in-flight handoff;
- six-role layout needs an eleventh line or loses its bottom rail;
- a mounted light-theme widget retains stale colors after a dark-theme toggle;
- static/no-next renderer omits same-role phase progress;
- contradictory or color-only role states.

## Residual risks

- A 180 ms refresh is intentional but must be observed in the real TUI for CPU
  cost and distraction. If it is visibly noisy, lengthen the interval; do not
  add a settings subsystem in this slice.
- Broker liveness is observational. `offline` means absent from the latest
  roster, not proven process death.
- Unicode display width varies by terminal font. ANSI-aware width checks and the
  ASCII glyph set contain the failure, but real terminal captures remain part
  of acceptance.

## Open questions

None. The user selected visual polish, full roster visibility, per-session
`YOU · role` labeling, active pulse plus transitions, more dynamic motion,
layered sections, and the connected command-frame wrapper.
