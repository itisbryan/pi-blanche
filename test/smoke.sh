#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Load the extension and verify its command path does not crash.
pi --no-extensions -e ./index.ts --no-session -p '/crew status' >/dev/null

id="smoke-$$"
trap 'rm -rf "$HOME/.pi/agent/pi-blanche/tasks/$id" "$HOME/.pi/agent/pi-blanche/smoke-session"' EXIT
mkdir -p "$HOME/.pi/agent/pi-blanche/tasks/$id/specs" "$HOME/.pi/agent/pi-blanche/tasks/$id/checkpoints" "$HOME/.pi/agent/pi-blanche/tasks/$id/consultations"
cat > "$HOME/.pi/agent/pi-blanche/tasks/$id/board.json" <<EOF
{"id":"$id","workflow":"feat","prefix":"smoke","cwd":"$PWD","status":"active","phase":"IMPLEMENTING","owner":"worker","revision":0,"task":{"title":"smoke","descriptionPath":"task.md"},"currentSpec":"s01","specs":{"s01":{"status":"implementing","path":"$PWD/specs/s01-core.md","dependsOn":[],"reworkRound":0,"lastAdvisorConsultedRound":null}},"consultations":[],"leader":{"sessionName":"smoke-$id-leader"},"resolved":{"workflow":"feat","prefix":"smoke","roster":["worker"],"agents":{},"phases":[{"name":"IMPLEMENTING","owner":"worker"}],"specs":true,"advisorAfter":null,"maxRework":3,"maxWorkers":1,"configRevision":"smoke"},"sessions":{},"reworkRound":0,"lastAdvisorConsultedRound":null,"history":[]}
EOF
printf 'smoke task\n' > "$HOME/.pi/agent/pi-blanche/tasks/$id/task.md"

reply=$(BLANCHE_ROLE=worker BLANCHE_TASK="$id" pi --no-extensions -e ./index.ts --session-dir "$HOME/.pi/agent/pi-blanche/smoke-session" -p 'Reply with only the phase name you were given.')
grep -q 'IMPLEMENTING' <<<"$reply" || { echo "model reply did not name IMPLEMENTING: $reply" >&2; exit 1; }
if grep -R -q 'BLANCHE_MARKER' "$HOME/.pi/agent/pi-blanche/smoke-session" --include='*.jsonl' 2>/dev/null; then
  echo 'injected prompt entered persisted history' >&2
  exit 1
fi
