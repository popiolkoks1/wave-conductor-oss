#!/usr/bin/env bash
# End-to-end test: toy repository, two waves, parallel tracks, supervisor question and merge conflict.
# Usage: npm run smoke (SMOKE_DIR selects the working directory; SMOKE_MODEL overrides the model).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
W="${SMOKE_DIR:-$(mktemp -d -t conductor-smoke)}"
MODEL="${SMOKE_MODEL:-claude-sonnet-5}"
rm -rf "$W/repo" "$W/repo-wt" "$W/state"
mkdir -p "$W/repo/test"
echo "Test directory: $W"

cd "$W/repo"
git init -q -b main
git config user.name "smoke"; git config user.email "smoke@example.invalid"; git config commit.gpgsign false
echo '{ "type": "module", "scripts": { "test": "node --test" } }' > package.json
printf '// Toy calculator for the conductor smoke test.\nexport const version = 1;\n' > calc.js
cat > test/version.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version } from '../calc.js';
test('version', () => assert.equal(version, 1));
JS
git add package.json calc.js test/version.test.js && git commit -qm "init"

cat > "$W/manifest.yaml" <<YAML
name: smoke-toy
repo: $W/repo
planDir: $HERE/plan
context: [RULES.md]
worktreeRoot: $W/repo-wt
stateDir: $W/state
maxParallel: 2
maxFixAttempts: 2
maxTurns: 60
maxBudgetUsd: 3
settingSources: []
notify: { macos: false, heartbeatHours: 0 }
models: { track: $MODEL, supervisor: $MODEL, merge: $MODEL }
waves:
  - id: w1
    gates: [{ name: tests, run: "node --test" }]
    tracks:
      - { id: add, promptFile: w1-add.md }
      - { id: mul, promptFile: w1-mul.md }
  - id: w2
    gates:
      - { name: tests, run: "node --test" }
      - { name: readme, run: "grep -q add README.md && grep -q multiply README.md" }
    tracks:
      - { id: docs, promptFile: w2-docs.md }
YAML

"$ROOT/bin/conduct" check "$W/manifest.yaml"
set +e
"$ROOT/bin/conduct" run "$W/manifest.yaml"
code=$?
set -e

echo; echo "════ ASSERTIONS ════"
fail=0
ok() { echo "✓ $1"; }
bad() { echo "✗ $1"; fail=1; }
S="$(ls -d "$W/state"/2* | tail -1)"
[ $code -eq 0 ] && ok "run completed with outcome done" || bad "exit code $code"
cd "$W/repo"
grep -q "export function add" calc.js && ok "add integrated into main" || bad "add missing from main"
grep -q "export function multiply" calc.js && ok "multiply integrated into main" || bad "multiply missing from main"
[ -f README.md ] && ok "wave 2 README integrated into main" || bad "README missing"
node --test >/dev/null 2>&1 && ok "tests pass on main" || bad "tests fail on main"
[ "$(git worktree list | wc -l | tr -d ' ')" = 1 ] && ok "worktrees cleaned up" || { bad "remaining worktrees:"; git worktree list; }
[ "$(git branch --format='%(refname:short)' | grep -vc '^main$')" = 0 ] && ok "branches cleaned up" || { bad "remaining branches:"; git branch; }
grep -q "Question:" "$S/DECISIONS.md" 2>/dev/null && ok "supervisor answered AskUserQuestion ($(grep -c 'Question:' "$S/DECISIONS.md") questions)" || bad "no supervisor answer in DECISIONS.md"
[ -f "$S/REPORT.md" ] && ok "report saved: $S/REPORT.md" || bad "report missing"
grep -q "DENIED" "$S/events.log" && echo "ℹ restrictions triggered: $(grep -c DENIED "$S/events.log")×" || echo "ℹ no session encountered a restriction"
grep -q "conflict in" "$S/events.log" && echo "ℹ merge conflict resolved by a session" || echo "ℹ integration without conflicts"
exit $fail
