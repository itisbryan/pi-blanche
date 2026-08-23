#!/usr/bin/env bash
# Cheapest check that fails if the two defects we actually shipped recur:
# a source file that does not parse, and a test file that asserts nothing.
# Runs before `npm test` via pretest.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

for f in *.ts; do
  [ "$f" = "types.ts" ] && continue
  if ! err=$(npx tsx -e "import('./$f')" 2>&1); then
    echo "GUARD FAIL: $f does not load — $(echo "$err" | grep -m1 ERROR || echo "$err" | head -1)"
    fail=1
  fi
done

for f in test/*.test.ts; do
  if ! grep -q 'assert' "$f"; then
    echo "GUARD FAIL: $f contains no assertions — a passing no-op test is a green light on nothing"
    fail=1
  fi
done

[ $fail -eq 0 ] && echo "guard: ok"
exit $fail
