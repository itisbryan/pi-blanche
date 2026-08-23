#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Load the extension and verify its command path does not crash.
pi --no-extensions -e ./index.ts --no-session -p '/crew status' >/dev/null

id="smoke-$$"
trap 'rm -rf "$HOME/.pi/agent/pi-blanche/tasks/$id" "$HOME/.pi/agent/pi-blanche/smoke-session"' EXIT
mkdir -p "$HOME/.pi/agent/pi-blanche/tasks/$id/specs" "$HOME/.pi/agent/pi-blanche/tasks/$id/checkpoints" "$HOME/.pi/agent/pi-blanche/tasks/$id/consultations"
printf 'CHECKPOINT_SENTINEL\n' > "$HOME/.pi/agent/pi-blanche/tasks/$id/checkpoints/s01-worker-e0.md"
printf 'OLD_CONSULTATION_SENTINEL\n' > "$HOME/.pi/agent/pi-blanche/tasks/$id/consultations/c-old.md"
printf 'WRONG_SPEC_CONSULTATION_SENTINEL\n' > "$HOME/.pi/agent/pi-blanche/tasks/$id/consultations/c-wrong-spec.md"
printf 'LATEST_CONSULTATION_SENTINEL\n' > "$HOME/.pi/agent/pi-blanche/tasks/$id/consultations/c-latest.md"
cat > "$HOME/.pi/agent/pi-blanche/tasks/$id/board.json" <<EOF
{"id":"$id","workflow":"feat","prefix":"smoke","cwd":"$PWD","status":"active","phase":"IMPLEMENTING","owner":"worker","revision":0,"task":{"title":"smoke","descriptionPath":"task.md"},"currentSpec":"s01","specs":{"s01":{"status":"implementing","path":"$PWD/specs/s01-core.md","dependsOn":[],"reworkRound":0,"lastAdvisorConsultedRound":null}},"consultations":[{"id":"c-old","role":"advisor","requestedBy":"worker","spec":"s01","reworkRound":0,"summaryPath":"consultations/c-old.md"},{"id":"c-wrong-spec","role":"advisor","requestedBy":"worker","spec":"s02","reworkRound":0,"summaryPath":"consultations/c-wrong-spec.md"},{"id":"c-latest","role":"advisor","requestedBy":"worker","spec":"s01","reworkRound":0,"summaryPath":"consultations/c-latest.md"}],"leader":{"sessionName":"smoke-$id-leader"},"resolved":{"workflow":"feat","prefix":"smoke","roster":["worker"],"agents":{},"phases":[{"name":"IMPLEMENTING","owner":"worker"}],"specs":true,"advisorAfter":null,"maxRework":3,"maxWorkers":1,"configRevision":"smoke"},"sessions":{"worker":{"sessionName":"smoke-$id-worker","contextEpoch":0,"latestCheckpoint":"checkpoints/s01-worker-e0.md"}},"reworkRound":0,"lastAdvisorConsultedRound":null,"history":[]}
EOF
printf 'smoke task\n' > "$HOME/.pi/agent/pi-blanche/tasks/$id/task.md"

reply=$(BLANCHE_ROLE=worker BLANCHE_TASK="$id" pi --no-extensions -e ./index.ts --session-dir "$HOME/.pi/agent/pi-blanche/smoke-session" -p 'Reply with exactly: IMPLEMENTING CHECKPOINT_SENTINEL LATEST_CONSULTATION_SENTINEL.')
grep -q 'IMPLEMENTING' <<<"$reply" || { echo "model reply did not name IMPLEMENTING: $reply" >&2; exit 1; }
grep -q 'CHECKPOINT_SENTINEL' <<<"$reply" || { echo "checkpoint contents did not reach the model: $reply" >&2; exit 1; }
grep -q 'LATEST_CONSULTATION_SENTINEL' <<<"$reply" || { echo "latest consultation contents did not reach the model: $reply" >&2; exit 1; }
if grep -q 'OLD_CONSULTATION_SENTINEL\|WRONG_SPEC_CONSULTATION_SENTINEL' <<<"$reply"; then
  echo "non-latest or wrong-spec consultation reached the model: $reply" >&2
  exit 1
fi
if grep -R -q 'BLANCHE_MARKER' "$HOME/.pi/agent/pi-blanche/smoke-session" --include='*.jsonl' 2>/dev/null; then
  echo 'injected prompt entered persisted history' >&2
  exit 1
fi
