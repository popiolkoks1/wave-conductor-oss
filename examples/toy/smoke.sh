#!/usr/bin/env bash
# Test końcowy: zabawkowe repo, 2 fale, 2 tory równolegle, pytanie do nadzorcy, konflikt przy scalaniu.
# Użycie: npm run smoke   (SMOKE_DIR=… żeby wskazać katalog roboczy; SMOKE_MODEL=… żeby zmienić model)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
W="${SMOKE_DIR:-$(mktemp -d -t conductor-smoke)}"
MODEL="${SMOKE_MODEL:-claude-sonnet-5}"
rm -rf "$W/repo" "$W/repo-wt" "$W/state"
mkdir -p "$W/repo/test"
echo "katalog testu: $W"

cd "$W/repo"
git init -q -b main
git config user.name "smoke"; git config user.email "smoke@example.invalid"; git config commit.gpgsign false
echo '{ "type": "module", "scripts": { "test": "node --test" } }' > package.json
printf '// Kalkulator zabawkowy dla testu dyrygenta.\nexport const version = 1;\n' > calc.js
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
context: [ZASADY.md]
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
    gates: [{ name: testy, run: "node --test" }]
    tracks:
      - { id: add, promptFile: w1-add.md }
      - { id: mul, promptFile: w1-mul.md }
  - id: w2
    gates:
      - { name: testy, run: "node --test" }
      - { name: readme, run: "grep -q add README.md && grep -q multiply README.md" }
    tracks:
      - { id: docs, promptFile: w2-docs.md }
YAML

"$ROOT/bin/conduct" check "$W/manifest.yaml"
set +e
"$ROOT/bin/conduct" run "$W/manifest.yaml"
code=$?
set -e

echo; echo "════ ASERCJE ════"
fail=0
ok() { echo "✓ $1"; }
bad() { echo "✗ $1"; fail=1; }
S="$(ls -d "$W/state"/2* | tail -1)"
[ $code -eq 0 ] && ok "przebieg zakończony wynikiem done" || bad "kod wyjścia $code"
cd "$W/repo"
grep -q "export function add" calc.js && ok "add w main" || bad "brak add w main"
grep -q "export function multiply" calc.js && ok "multiply w main" || bad "brak multiply w main"
[ -f README.md ] && ok "README z fali 2 w main" || bad "brak README"
node --test >/dev/null 2>&1 && ok "testy zielone na main" || bad "testy czerwone na main"
[ "$(git worktree list | wc -l | tr -d ' ')" = 1 ] && ok "worktree posprzątane" || { bad "zostały worktree:"; git worktree list; }
[ "$(git branch --format='%(refname:short)' | grep -vc '^main$')" = 0 ] && ok "gałęzie posprzątane" || { bad "zostały gałęzie:"; git branch; }
grep -q "Pytanie:" "$S/DECYZJE.md" 2>/dev/null && ok "nadzorca odpowiedział na AskUserQuestion ($(grep -c 'Pytanie:' "$S/DECYZJE.md") pyt.)" || bad "brak odpowiedzi nadzorcy w DECYZJE.md"
[ -f "$S/REPORT.md" ] && ok "raport zapisany: $S/REPORT.md" || bad "brak raportu"
grep -q "ZAKAZ" "$S/events.log" && echo "ℹ zakazy zadziałały: $(grep -c ZAKAZ "$S/events.log")×" || echo "ℹ żadna sesja nie trafiła na zakaz"
grep -q "konflikt przy" "$S/events.log" && echo "ℹ konflikt scalania rozwiązany przez sesję" || echo "ℹ scalanie bez konfliktu"
exit $fail
