# Advisor Consultation c-001 — both specs failed QA twice

Requested by: blanche-qa (escalation), blanche-worker-1, blanche-worker-2
Rework round: 2 on s01, 2 on s02

## Diagnosis

Two defects, one mechanical and one procedural. Neither is a reasoning failure,
so a third round of the same approach would have failed the same way.

**1. `config.ts` never parsed.** Line 8 contains literal `\n` tokens *between
statements*, outside any string:

```
"qa", "verifier"];\nconst rawTexts = new WeakMap<object, string>();\nfunction val
```

The file was written through something that escaped newlines instead of emitting
them. Note the other files are fine: `board.ts`, `handoff.ts`, `inject.ts` and
`spawn.ts` also match `grep '\n'`, but there the `\n` are legitimate string
literals (`join("\n")`) and all four import cleanly. This is one file, one write,
one mangled mechanism — not a pattern of bad code.

**2. Three test files assert nothing.** `test/config.test.ts`,
`test/board.test.ts` and `test/handoff.test.ts` each contain a single
`test('… suite', () => {})` with one import and zero assertions. They pass. A
passing no-op test is worse than a missing one: it reports green while proving
nothing, which is exactly how a broken `config.ts` reached QA twice.

## Why previous attempts failed

Neither worker had a way to find out they were wrong before handing off.

- `npm test` was green, because no-op tests pass.
- `npm run typecheck` was dead — `tsc` was never a dependency of this repo.
  That is my defect, not theirs: I wrote the script into `package.json` and
  never installed a toolchain. `tsc` would have caught the `config.ts` syntax
  error on the first run.

So round 2 fixed what QA named and re-shipped the same class of defect, because
the verification gap was upstream of both workers.

## Recommended approach

Fixed already, by me, so neither worker needs to touch shared files:

- Installed `typescript`, `@types/node`, `tsx` locally; added `tsconfig.json`
  with `paths` pointing at the real pi packages in `~/.pi/agent/npm/node_modules`.
  `npm run typecheck` now works and fails loudly on `config.ts`.
- Added `test/guard.sh`, wired as `pretest`, which fails when any source file
  does not load, or any test file contains no assertion. Verified: it flags
  exactly the four real defects and false-positives on nothing.
- `npm run verify` = typecheck + guard + tests. **No handoff to QA without a
  clean `npm run verify`.**

blanche-worker-1:
1. Rewrite `config.ts` with real newlines — use the file-write tool, not a shell
   heredoc or printf with escapes. Do not hand-patch line 8; the whole file went
   through the bad path, so re-emit it.
2. Make the three test files real: import the module under test, use
   `node:assert/strict`, and cover the cases listed in `specs/s01-core.md`.
3. `npx tsx -e "import('./config.ts')"` after every write. One second, and it
   catches this entire class instantly.

blanche-worker-2:
1. Assert the spec **goal** as well as acceptance criteria — pass a `specBody`
   containing a distinct goal string and assert both appear.
2. Add the exact-argv shell-quoting test: cwd with a space and a quote, session
   name with `$`.
3. Make `test/smoke.sh` actually perform the injection proof: seed a task with
   `createTask`, run pi into `--session-dir`, assert the reply names the seeded
   phase, and assert zero marker hits in the resulting `.jsonl`. As written it
   exits 0 without proving anything, which is the same failure mode as a no-op
   test.

## Do not change

- `types.ts` — unchanged, still the contract.
- Each other's files. The write-scope split stands.
- The design decisions in `docs/specs/2026-08-23-pi-blanche-extension.md`. None
  of this is an architecture problem.

## Validation

Both workers: `npm run verify` clean, then hand to QA with the sha. QA re-runs
the same command — if it is green there and the listed cases assert real
behaviour, that is PASS.
