#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

command -v pi >/dev/null || { echo "load-window requires pi" >&2; exit 1; }
command -v npx >/dev/null || { echo "load-window requires npx" >&2; exit 1; }

repo="$PWD"
real_home="$HOME"
agent_dir="${PI_CODING_AGENT_DIR:-$real_home/.pi/agent}"
intercom_extension="${BLANCHE_INTERCOM_EXTENSION:-$agent_dir/npm/node_modules/pi-intercom/index.ts}"
model="${BLANCHE_LOAD_WINDOW_MODEL:-openai-codex/gpt-5.4-mini}"

[[ -f "$intercom_extension" ]] || {
	echo "load-window requires pi-intercom: $intercom_extension" >&2
	exit 1
}

run_case() {
	local label="$1"
	local extension="$2"
	local scratch home cwd out err id rc
	scratch=$(mktemp -d "${TMPDIR:-/tmp}/blanche-load-window.XXXXXX")
	home="$scratch/home"
	cwd="$scratch/cwd"
	out="$scratch/stdout"
	err="$scratch/stderr"
	id="load-window-${label}-$$"
	mkdir -p "$home" "$cwd"

	if ! (cd "$repo" && HOME="$home" PI_CODING_AGENT_DIR="$agent_dir" E2E_ID="$id" E2E_CWD="$cwd" npx tsx -e '
		import { createTask } from "./board.ts";
		const id = process.env.E2E_ID!;
		const cwd = process.env.E2E_CWD!;
		createTask({
			id,
			workflow: "e2e",
			title: "extension load regression",
			description: "active task for extension-load regression",
			cwd,
			resolved: {
				workflow: "e2e",
				prefix: "e2e",
				roster: ["worker"],
				agents: { worker: { model: "test", thinking: "off" } },
				phases: [{ name: "REQUESTED", owner: "leader" }],
				specs: false,
				advisorAfter: null,
				maxRework: 1,
				maxWorkers: 1,
				configRevision: "load-window",
			},
			prefix: "e2e",
			phase: "REQUESTED",
			owner: "leader",
			leader: { sessionName: "load-window-leader" },
		});
	' >/dev/null); then
		echo "[$label] failed to seed active task" >&2
		rm -rf "$scratch"
		return 1
	fi

	rc=0
	(
		cd "$cwd"
		HOME="$home" PI_CODING_AGENT_DIR="$agent_dir" \
			pi --no-extensions \
			-e "$intercom_extension" \
			-e "$extension" \
			--no-session --model "$model" --thinking off -p 'say ok'
	) >"$out" 2>"$err" || rc=$?

	if ((rc != 0)); then
		echo "[$label] pi exited $rc" >&2
		cat "$out" >&2
		cat "$err" >&2
		rm -rf "$scratch"
		return 1
	fi
	if ! grep -Eiq '(^|[^[:alnum:]_])ok([^[:alnum:]_]|$)' "$out"; then
		echo "[$label] stdout did not contain ok" >&2
		cat "$out" >&2
		rm -rf "$scratch"
		return 1
	fi
	if grep -Eiq 'Extension runtime not initialized|Event handler error|at getSessionName|registerLocalExtension' "$out" "$err"; then
		echo "[$label] extension-load error leaked to output" >&2
		cat "$out" >&2
		cat "$err" >&2
		rm -rf "$scratch"
		return 1
	fi

	echo "load-window PASS ($label)"
	rm -rf "$scratch"
}

run_case source "$repo/index.ts"

installed_index="${BLANCHE_INSTALLED_EXTENSION:-$real_home/.pi/agent/git/github.com/itisbryan/pi-blanche/index.ts}"
if [[ -f "$installed_index" ]]; then
	run_case installed "$installed_index"
else
	echo "load-window installed copy skipped ($installed_index not found)"
fi
