#!/usr/bin/env bash
# Deterministic Herdr stub using the real envelope shapes.
set -euo pipefail
printf '%s\n' "$*" >> "${HERDR_STUB_LOG:?}"
case "$1 $2" in
  "pane split")   printf '%s\n' '{"id":"cli:pane:split","result":{"pane":{"pane_id":"stub:pane:42"}}}' ;;
  "pane run")     printf '%s\n' '{"id":"cli:pane:run","result":{"ok":true}}' ;;
  "pane close")   printf '%s\n' '{"id":"cli:pane:close","result":{"ok":true}}' ;;
  "session list") printf '%s\n' '{"sessions":[{"default":true,"name":"default","running":true}]}' ;;
  *)              printf '%s\n' '{"id":"cli:other","result":{"ok":true}}' ;;
esac
