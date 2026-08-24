#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Half A is headless and model-free: the extension harness exercises kickoff
# against the deterministic Herdr stub and asserts the opening handoff.
npx tsx --test test/index.test.ts

if [[ -n "${BLANCHE_CLAUDE_BRIDGE:-}" ]]; then
  bridge_model="${BLANCHE_CLAUDE_MODEL:-claude-bridge/claude-haiku-4-5}"
  pi --no-extensions -e ./index.ts --no-session --model "$bridge_model" -p 'Reply with exactly: ok' | grep -qi '\bok\b'
  echo "claude-bridge smoke PASS ($bridge_model)"
fi

# Half B is an opt-in real-model test. Forks and CI without credentials remain
# green while an explicitly enabled run proves that a handoff caused a real
# receiving turn, not merely a sendMessage call.
if [[ -z "${BLANCHE_E2E:-}" ]]; then
  echo "e2e delivery skipped (set BLANCHE_E2E=1 to use a real pi/model)"
  exit 0
fi
command -v herdr >/dev/null || { echo "e2e requires herdr" >&2; exit 1; }

repo="$PWD"
real_home="$HOME"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/blanche-e2e.XXXXXX")
herdr_pane=""
cleanup() {
  if [[ -n "$herdr_pane" ]]; then
    herdr pane close "$herdr_pane" >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -p "$scratch/home"
# Blanche task state follows HOME; pi/intercom credentials and the live broker
# stay on the normal coding-agent directory so the real pane can register.
export HOME="$scratch/home"
export PI_CODING_AGENT_DIR="$real_home/.pi/agent"

task_id="e2e-delivery-$$"
nonce="BLANCHE_E2E_NONCE_$$"
model="${BLANCHE_E2E_MODEL:-openai-codex/gpt-5.4-mini}"
E2E_ID="$task_id" E2E_NONCE="$nonce" E2E_MODEL="$model" \
  npx tsx -e '
    import {createTask, updateBoard, taskDir} from "./board.ts";
    const id = process.env.E2E_ID!;
    const nonce = process.env.E2E_NONCE!;
    const model = process.env.E2E_MODEL!;
    const resolved = {
      workflow: "e2e", prefix: "e2e", roster: ["researcher"],
      agents: {researcher: {model, thinking: "low"}},
      phases: [{name: "REQUESTED", owner: "leader"}, {name: "INVESTIGATING", owner: "researcher"}],
      specs: false, advisorAfter: null, maxRework: 1, maxWorkers: 1, configRevision: "e2e",
    };
    createTask({id, workflow: "e2e", title: id, description: "real delivery", cwd: process.cwd(), resolved, prefix: "e2e", phase: "INVESTIGATING", owner: "researcher", leader: {sessionName: "e2e-leader"}});
    updateBoard(id, (board) => {
      board.sessions.researcher = {sessionName: `e2e-${id}-researcher`, contextEpoch: 0};
      board.history.push({handoffId: `handoff-${id}`, from: "leader", to: "researcher", phase: "INVESTIGATING", verdict: null, message: nonce, sentAt: Date.now()});
    });
    console.log(taskDir(id) + "/board.json");
  '

board_file="$HOME/.pi/agent/pi-blanche/tasks/$task_id/board.json"
# A real Herdr pane supplies the TTY that lets the receiver register with the
# intercom broker. The interactive receiver starts without a competing -p turn;
# only a delivered handoff can put the nonce into the model's reply.
split=$(herdr pane split --current --direction right --cwd "$scratch")
herdr_pane=$(printf '%s' "$split" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(JSON.parse(s).result.pane.pane_id))')
quote() { printf '%q' "$1"; }
pi_cmd="cd $(quote "$scratch") && HOME=$(quote "$HOME") PI_CODING_AGENT_DIR=$(quote "$PI_CODING_AGENT_DIR") BLANCHE_ROLE=researcher BLANCHE_TASK=$(quote "$task_id") pi --session-dir $(quote "$scratch/sessions") --no-extensions -e $(quote "$real_home/.pi/agent/npm/node_modules/pi-intercom/index.ts") -e $(quote "$repo/index.ts") --name $(quote "e2e-$task_id-researcher") --model $(quote "$model") --thinking low"
herdr pane run "$herdr_pane" "$pi_cmd" >/dev/null

if ! herdr pane wait-output --match "$nonce" --timeout "${BLANCHE_E2E_TIMEOUT_MS:-120000}" "$herdr_pane" > "$scratch/output"; then
  echo "real receiver board before nonce:" >&2
  cat "$board_file" >&2 || true
  echo "real receiver pane output before nonce:" >&2
  herdr pane read "$herdr_pane" --source recent --format text --lines 100 >&2 || true
  exit 1
fi
for _ in {1..30}; do
  grep -q '"ackedAt"' "$board_file" && break
  sleep 1
done
grep -q '"ackedAt"' "$board_file" || { echo "real turn output arrived but handoff was not acknowledged" >&2; cat "$scratch/output" >&2; exit 1; }
grep -q "$nonce" "$scratch/output" || { echo "receiving turn did not echo the persisted handoff nonce" >&2; cat "$scratch/output" >&2; exit 1; }
echo "e2e delivery PASS: real pane turn echoed $nonce and acked the board handoff"
