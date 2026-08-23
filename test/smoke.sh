#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pi --no-extensions -e ./index.ts --no-session -p '/crew status'
# Full injection proof requires a seeded task directory and a configured pi/herdr runtime.
# When BLANCHE_TASK is supplied, run a real session and assert the ephemeral marker is absent.
if [[ -n "${BLANCHE_TASK:-}" ]]; then
  dir="${BLANCHE_SESSION_DIR:-/tmp/blanche-smoke}"
  rm -rf "$dir"
  BLANCHE_ROLE=worker BLANCHE_TASK="$BLANCHE_TASK" pi --no-extensions -e ./index.ts --session-dir "$dir" -p 'Reply with the phase name you were given.'
  if grep -R -q 'BLANCHE_MARKER' "$dir"/*.jsonl 2>/dev/null; then
    echo 'injected prompt entered persisted history' >&2
    exit 1
  fi
fi
