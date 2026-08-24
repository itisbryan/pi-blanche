[Index](architecture.md)

# 7. Verification

## 7.1 What is proven

51 automated tests, plus lint, type-check and a loadability guard, all run in CI
(`npm run verify` = `biome ci` → `tsc --noEmit` → `test/guard.sh` → `node --test`).

### `config.test.ts` — 7

Resolution of workflow presets and agent profiles.

- feat crew resolves with the documented shape
- unknown workflow throws naming the known workflows
- absent config file falls back to `DEFAULT_CONFIG` and writes it on first use
- workflow agent override beats the top-level profile **for that role only**
- `configRevision` hashes the raw file text, not a re-serialisation
- `resolveCrew` keeps only roster roles in agents
- validation rejects a bad phase owner **naming the JSON path**

### `board.test.ts` — 9

Durable state and the mutation primitive.

- task directory is deterministic
- create → read → write → read preserves fields and bumps revision exactly once
- `createTask` makes sibling spec/checkpoint/consultation dirs, not nested ones
- `writeCheckpoint` lands in `checkpoints/` and omits empty sections
- **`updateBoard` reads fresh state, applies a mutation, and bumps revision once**
- after `writeBoard` no `.tmp` remains and the board parses
- `listTasks` returns saved boards
- `listTasks` orders by recency, not by task id
- `listTasks` cwd filter normalises trailing slashes, dot segments and symlinks

### `handoff.test.ts` — 15

The pure reducer, including all escalation logic.

- qa `PASS` to worker moves phase, owner and appends history
- planner to **leader** targets the leader session
- unknown phase falls back to the destination as owner
- destination outside the roster errors and lists the roster
- roster role whose session is not live errors naming it
- qa sending a verifier verdict errors naming `PASS|FAIL`
- worker sending any verdict errors
- exceeding `maxRework` refuses and names the leader
- **a rejected decision returns the board deep-equal to the input** (I3)
- `FAIL` to worker increments board rework when specs are off
- **an empty-string spec id still counts board rework**
- rework is per spec when specs are on: `s02` failing twice leaves `s03` at 0
- `advisorAfter: null` never nudges
- `advisorAfter: 2` nudges at rework 2 **and again at 3** until a consultation lands
- a missing checkpoint warns but does not block

### `inject.test.ts` — 4

Prompt assembly and process spawning.

- renders worker block with spec, checkpoint, and peers
- **spawn command quotes spaces, apostrophes, and dollar signs exactly**
- context pressure is absent below limit and present once at limit
- assembly is stable and omits missing optional sections

### `lifecycle.test.ts` — 12

Resume, stop, clean, checkpoint, consult.

- resume with all sessions live spawns nothing and reactivates the task
- **resume republishes an unacked final handoff but not an acked one**
- **resume replays the persisted resolved snapshot after config changes**
- resume with an unknown id names the task and existing ids
- checkpoint writes the file, records its path, and bumps revision once
- **consult persists a record and leaves phase, owner, and currentSpec unchanged**
- consult rejects an empty answer without changing the advisor round
- stop preserves phase, owner, and spec; stopping again is a no-op
- clean on an unknown id errors without deleting an existing task
- **resume, stop, and clean are reachable through the one `/crew` command**
- **concurrent checkpoint-style and handoff mutations both survive `updateBoard`**
- clean deletes only the task directory, including recorded panes

### `receive.test.ts` — 4

Delivery.

- delivers matching unseen handoff
- rejects wrong task, role, duplicate, and malformed payload
- **rejected handoff leaves `board.json` byte-identical**
- **successful handoff persists the reducer result before publishing**

### The guard

`test/guard.sh` runs as `pretest` and fails if:

- any source file does not load (`npx tsx -e "import('./x.ts')"`), or
- any test file contains no `assert`.

Both conditions were real defects, not hypotheticals. A source file with escaped
newline tokens outside string literals parsed as nonsense; three test files
contained a single `test('… suite', () => {})` with no assertions and passed,
reporting green while proving nothing.

The guard cannot establish *behavioural* coverage — a grep does not know which
cases matter. That remains qa's job, and holding specs to their listed test
cases is what caught the vacuous files.

## 7.2 Three defects that passed a green suite

Recorded because each is a distinct class, and each survived a fully green
suite plus review.

### Defect 1 — duplicate command registration

`index.ts` and `lifecycle.ts` both called `pi.registerCommand("crew")`. One
silently won. Every lifecycle command — `resume`, `stop`, `clean`, the entire
durability surface — was unreachable while 48 tests passed and two review passes
approved it.

**Why tests could not see it.** `lifecycle.test.ts` called `registerLifecycle`
in isolation and asserted the command was installed. In isolation there is
nothing to collide with, so the assertion was true and the system was broken.

**Found by** running the extension for real and typing `/crew resume`.

**Fix.** `index.ts` owns the one registration and delegates unrecognised actions
to a `handleAction` returned by `registerLifecycle`. The test now asserts the
lifecycle actions are reachable **through the single registered command**.

### Defect 2 — discarded reducer result

The handoff tool computed a correct new board and never wrote it back.
`decideHandoff` clones its input and returns a new board; the tool read
`decision` but passed `fresh` to `updateBoard`. A **successful** handoff
persisted `revision++` and nothing else — phase, owner, currentSpec, history and
rework all discarded. The board never advanced.

**Why tests could not see it.** `receive.test.ts` covered the *rejection* path,
and the concurrency test drove `updateBoard` with a hand-written `history.push`.
A complete no-op satisfies both.

**Fix.** `Object.assign(fresh, next.board)` inside the callback, plus a test
that re-reads the board **from disk** after a successful handoff and asserts the
transition, the single new history entry with `ackedAt` unset, and revision + 1.
Asserting on the in-memory return value would have passed against the broken
code too.

### Defect 3 — unverified external contract

The response envelope of the pane manager was assumed rather than checked. Real
output is:

```json
{"id":"cli:pane:split","result":{"pane":{"pane_id":"w2K:p9"}}}
```

The extractor looked for `record.pane`, found none at the top level, fell back
to the envelope itself, and matched its `id` — returning the literal string
`"cli:pane:split"` as the pane identifier, for every role. Consequences: `pane
run` targeted nothing, the board recorded a bogus id per session, and `clean`
closed nothing while real panes leaked.

Compounding it, registration polling called `herdr session list --json`, which
returns herdr *terminal* sessions, and matched them against a pi session name
announced on the **intercom broker**. It could never succeed.

**Root cause of both.** One function never unwrapped the `result` envelope.

**Fix.** A conditional unwrap in the shared function — conditional because the
tool is inconsistent: `pane split` wraps, `session list --json` does not. Plus
polling the intercom roster via the helper that already existed. Notably the
extractor was **left strict**: its strictness is what should have failed loudly,
and the envelope feed was the actual defect.

### 7.2.1 Generalisations

**Verify an assumed output shape against the real tool, once.** Any code that
shells out has a contract with something outside the type system. Defect 3 was
invisible to review because the parsing was self-consistent — it was consistent
with the wrong shape.

**An optional parameter with a broken default preserves the defect in every
caller that omits it.** The first fix for defect 3 made the roster parameter
optional with a fallback to the broken function. Kickoff passed it and worked;
`resume` did not and stayed broken — green build, one caller fixed, one caller
silently not. The parameter was made **required** and the fallback deleted, so
the compiler enumerated the call sites.

**A confidently wrong value is worse than an absent one.** Defects 1 and 3 both
produced plausible-looking wrong behaviour rather than an error. So did a fourth,
smaller one: a helper that annotated every spec with the board's current owner
via three ternary branches that all returned the same value — displaying
`owner worker` against a finished spec.

## 7.3 Why qa owns the tests

Test files are authored by qa, not by the implementing agent.

This was a process change made in response to a pattern, not a preference. Thin
coverage failed review **twice on the same agent** and cost four rounds, always
the same loop: the spec lists cases → the agent writes just enough to satisfy
the gate → qa enumerates precisely what is missing → the agent guesses again.

qa was right every time and specific every time. Having qa *describe* tests for
someone else to write worse is pure round-trip. So qa writes them and the agent
implements until green. A red test file written ahead of implementation is the
clearest possible statement of a contract — the one time it was tried, the fix
landed in minutes because there was nothing left to guess.

Independence is preserved by the verifier, who reviews the implementation *and*
qa's tests against the design. qa authoring assertions it will later run remains
independent of the implementation, which is the property that matters.

## 7.4 Live verification

**A live kickoff against real panes now passes.** `/crew investigate "..."`
spawned real herdr panes, both agents registered on the broker, the opening
handoff was committed, published, delivered and acknowledged without
intervention, and the researcher ran a real turn — reading the file and
answering. Board: `phase INVESTIGATING`, `acked: true`, pane context 0.0% →
7.9%.

It took four defects to get there, none of which any test could see, and all
four were in the seam between the extension and its host:

1. **`BLANCHE_ROLE`/`BLANCHE_TASK` exist only in spawned panes.** In the
   operator's own session both were undefined, so `handoff` threw and `status`
   printed nothing — the one session allowed to start a task could not.
2. **`handoff` is an agent tool, so an operator cannot call it.** Kickoff created
   a task at `REQUESTED` owned by the leader with no operator-facing way to
   start it. Kickoff now performs the opening handoff itself.
3. **Delivery depended on two single moments.** A publish before the receiver's
   channel negotiated was dropped; a single pull-on-ready before the sender
   committed saw nothing. Now polled.
4. **`pi.sendMessage` takes a `CustomMessage`, not a string.** Passing a bare
   string injected nothing, silently. Handoffs were committed, published,
   delivered *and acked* while no turn ever ran — the board looked healthy and
   the pane sat at 0.0% context.

Defect 4 is the sharpest instance of the rule in
[§7.2.1](#721-generalisations): a confidently wrong value beats an absent one
for how long it hides. Every observable said delivered.

### Still unproven

A full multi-role cycle — worker → qa → verifier with a rework loop and an
advisor escalation — has not been run live. Only the opening handoff of a
two-role `investigate` has.

Pane lifecycle *is* exercised against `test/fake-herdr.sh`, a stub emitting the
real response envelopes, asserting that the identifier is extracted from
`result.pane.pane_id` and that cleanup closes the pane it opened. That covers
everything up to the point where a real process must appear on the broker.

A headless harness cannot close the remaining gap: a spawned agent launched
without a controlling terminal starts, stays alive, and never registers. Only a
real pane provides the TTY. This was attempted and is reported as a negative
result rather than omitted.

Given that all three defects in 7.2 were invisible to a green suite, **this gap
should be treated as material, not cosmetic.**

## 7.5 Limitations

- **Parallel workers.** `maxWorkers: 1`. Spec metadata (`dependsOn`,
  `parallelSafe`, `writeScope`) is recorded during grooming, so the data model
  admits a scheduler, but none is implemented. Deferred until sequential
  execution is demonstrated to be the bottleneck — and note that the first
  observed cost of concurrency was not compute but coordination: two agents in
  one tree collided at the version-control layer within minutes.
- **Single host.** Broker and task directory are local.
- **Advisory protocol.** Only the rework bound is enforced.
- **Lock ceiling.** [6.3](consistency.md#63-known-ceiling).
- **Consultation model.** One-shot: the advisor records a conclusion, and there
  is no pending-request state. An earlier two-phase design wrote an empty
  consultation at *request* time and marked the round consulted before any
  advice existed — which silently disabled escalation for that round, letting a
  worker mute the advisor by asking anything at all.
- **Unbounded history.** `board.history` grows without pruning.

## 7.6 References

Verified against the running host (pi 0.84.2):

| Claim | Source |
|---|---|
| Extension-returned system prompt stored in `_systemPromptOverride`, reset per turn, never appended to history | `agent-session.js:902,907` |
| `session_compact` emitted **after** compaction | `agent-session.js:1441,1679` |
| `reason: "manual" \| "threshold" \| "overflow"` | `extensions/types.d.ts:448` |

