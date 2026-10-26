#!/usr/bin/env bash
# Resilience test: background daemon, notification monitoring and deliberate failures.
# - Track broken cannot pass its gate; defer it and continue.
# - Tracks c1/c2 pass individually but fail together; integrate one at a time and defer c2.
# - The gate named never is already failing on main; keep it informational.
# - SIGKILL the conductor; the daemon resumes and terminates orphan processes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
C="$ROOT/bin/conduct"
W="${SMOKE_DIR:-$(mktemp -d -t conductor-res)}"
MODEL="${SMOKE_MODEL:-claude-sonnet-5}"
rm -rf "$W/repo" "$W/repo-wt" "$W/state"; mkdir -p "$W/repo/test"
echo "Test directory: $W"
cd "$W/repo"
git init -q -b main
git config user.name "smoke"; git config user.email "smoke@example.invalid"; git config commit.gpgsign false
echo '{ "type": "module" }' > package.json
printf 'export const version = 1;\n' > calc.js
printf "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { version } from '../calc.js';\ntest('v', () => assert.equal(version, 1));\n" > test/version.test.js
git add package.json calc.js test/version.test.js && git commit -qm init

cat > "$W/manifest.yaml" <<YAML
name: smoke-resilience
repo: $W/repo
planDir: $HERE/plan-resilience
context: [RULES.md]
worktreeRoot: $W/repo-wt
stateDir: $W/state
maxParallel: 4
maxFixAttempts: 0
maxTurns: 40
maxBudgetUsd: 2
maxRunBudgetUsd: 20
minFreeGb: 1
settingSources: []
notify: { macos: false, heartbeatHours: 0 }
models: { track: $MODEL, supervisor: $MODEL, merge: $MODEL }
waves:
  - id: w1
    gates:
      - { name: tests, run: "node --test" }
      - { name: never, run: "test -f NEVER.txt" }
    integrationGates:
      - { name: tests, run: "node --test" }
      - { name: one-slot, run: "[ \$(ls slot-*.txt 2>/dev/null | wc -l) -le 1 ]" }
    tracks:
      - { id: add, promptFile: w1-add.md }
      - { id: broken, promptFile: w1-broken.md, gates: [{ name: integration-only, run: "[ \$(git rev-parse --abbrev-ref HEAD) = integration/w1 ]" }] }
      - { id: c1, promptFile: w1-c1.md }
      - { id: c2, promptFile: w1-c2.md }
  - id: w2
    gates:
      - { name: tests, run: "node --test" }
      - { name: wave-readme, run: "grep -q add README.md", baseline: false }
    tracks:
      - { id: docs, promptFile: w2-docs.md }
YAML

"$C" doctor "$W/manifest.yaml"
"$C" start "$W/manifest.yaml" > "$W/start.json"
cat "$W/start.json"
RUN_DIR="$(node -e "console.log(require('$W/start.json').dir)")"

# Watch from 0 to include the start notification.
"$C" watch "$W/manifest.yaml" --from 0 > "$W/watch.log" &
WATCH=$!

# Kill the conductor child, not the daemon, after the first track passes.
until grep -q "PASSING" "$RUN_DIR/events.log" 2>/dev/null; do sleep 2; done
CHILD="$(node -e "console.log(require('$W/state/current.json').childPid)")"
echo ">>> SIGKILL conductor process $CHILD (daemon should resume)"
kill -9 "$CHILD"

wait $WATCH || true
sleep 2
echo; echo "════ ASSERTIONS ════"
fail=0; ok() { echo "✓ $1"; }; bad() { echo "✗ $1"; fail=1; }
cat "$W/watch.log"
grep -q '^done|' "$W/watch.log" && ok "watch received done" || bad "watch did not receive done"
[ "$(grep -c '^wave|' "$W/watch.log")" = 2 ] && ok "two wave notifications" || bad "wave notifications: $(grep -c '^wave|' "$W/watch.log")"
grep -q "conductor process crashed" "$RUN_DIR/events.log" && ok "daemon resumed after SIGKILL" || bad "daemon did not resume"
cd "$W/repo"
grep -q "export function add" calc.js && ok "add integrated into main" || bad "add missing"
[ -f README.md ] && ok "wave 2 integrated despite deferred tracks" || bad "README missing"
[ ! -f BROKEN.txt ] && ok "broken excluded from main" || bad "BROKEN.txt unexpectedly integrated into main"
[ "$(ls slot-*.txt 2>/dev/null | wc -l | tr -d ' ')" = 1 ] && ok "exactly one conflicting track was integrated" || bad "slots: $(ls slot-*.txt 2>/dev/null)"
node --test >/dev/null 2>&1 && ok "tests pass on main" || bad "tests fail"
grep -q "never" "$RUN_DIR/REPORT.md" && grep -q "already failing on main" "$RUN_DIR/REPORT.md" && ok "baseline failure is informational in the report" || bad "baseline failure missing from report"
grep -q "wave|[0-9]*|wave w2.*already failing on main" "$W/watch.log" && bad "new acceptance gate (baseline: false) was incorrectly informational" || ok "wave 2 acceptance gate blocks failures"
grep -q "Fallback integration" "$RUN_DIR/REPORT.md" && ok "report records fallback integration" || bad "fallback integration missing from report"
git branch --format='%(refname:short)' | grep -q "wave/broken" && ok "deferred track branch retained for review" || bad "wave/broken branch missing"
[ "$(git worktree list | wc -l | tr -d ' ')" = 1 ] && ok "worktrees cleaned up" || { bad "worktrees remain"; git worktree list; }
pgrep -f "$W/repo-wt/" >/dev/null && bad "processes remain in worktrees" || ok "no orphan processes"
echo "ℹ report: $RUN_DIR/REPORT.md"
exit $fail
