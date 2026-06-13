#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"

tool_name="$(
  PAYLOAD="$payload" python3 - <<'PY'
import json
import os
try:
    print(json.loads(os.environ["PAYLOAD"]).get("tool_name", ""))
except Exception:
    print("")
PY
)"

if [ "$tool_name" != "AskUserQuestion" ]; then
  exit 0
fi

state_dir="${DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}"
bridge_dir="$state_dir/question-bridge"
timeout_seconds="${DISCORD_QUESTION_BRIDGE_HOOK_TIMEOUT_SECONDS:-1800}"
mkdir -p "$bridge_dir"
chmod 700 "$bridge_dir" 2>/dev/null || true

request_id="$(date +%s%N)-$$-${RANDOM}"
request_file="$bridge_dir/$request_id.request.json"
response_file="$bridge_dir/$request_id.response.json"
tmp_file="$request_file.tmp"

PAYLOAD="$payload" REQUEST_ID="$request_id" python3 - <<'PY' > "$tmp_file"
import json
import os
payload = json.loads(os.environ["PAYLOAD"])
print(json.dumps({
    "request_id": os.environ["REQUEST_ID"],
    "hook": payload,
}))
PY
chmod 600 "$tmp_file" 2>/dev/null || true
mv "$tmp_file" "$request_file"

cleanup() {
  rm -f "$request_file" "$response_file" "$tmp_file" 2>/dev/null || true
}
trap cleanup EXIT

deadline=$(( $(date +%s) + timeout_seconds ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -f "$response_file" ]; then
    cat "$response_file"
    exit 0
  fi
  sleep 1
done

cat <<'JSON'
{"hookSpecificOutput":{"permissionDecision":"deny"},"systemMessage":"AskUserQuestion timed out waiting for the Discord question bridge. Ask the user in Discord instead."}
JSON
