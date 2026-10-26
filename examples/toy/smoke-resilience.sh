#!/usr/bin/env bash
# Test odporności: start w tle (demon) + watch jak w sesji Claude + celowe usterki:
#  - tor „broken” nie może przejść bramki → odłożony, fala idzie dalej
#  - tory c1/c2 zielone osobno, razem łamią bramkę integracji → awaryjne scalanie po jednym, c2 odłożony
#  - bramka „never” czerwona już na main → tylko informacyjna
#  - proces dyrygenta ubity SIGKILL w trakcie → demon wznawia sam, sieroty ubite
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
C="$ROOT/bin/conduct"
W="${SMOKE_DIR:-$(mktemp -d -t conductor-res)}"
MODEL="${SMOKE_MODEL:-claude-sonnet-5}"
rm -rf "$W/repo" "$W/repo-wt" "$W/state"; mkdir -p "$W/repo/test"
echo "katalog testu: $W"
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
context: [ZASADY.md]
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
      - { name: testy, run: "node --test" }
      - { name: never, run: "test -f NEVER.txt" }
    integrationGates:
      - { name: testy, run: "node --test" }
      - { name: jeden-slot, run: "[ \$(ls slot-*.txt 2>/dev/null | wc -l) -le 1 ]" }
    tracks:
      - { id: add, promptFile: w1-add.md }
      - { id: broken, promptFile: w1-broken.md, gates: [{ name: tylko-integracja, run: "[ \$(git rev-parse --abbrev-ref HEAD) = integration/w1 ]" }] }
      - { id: c1, promptFile: w1-c1.md }
      - { id: c2, promptFile: w1-c2.md }
  - id: w2
    gates:
      - { name: testy, run: "node --test" }
      - { name: readme-w-fali, run: "grep -q add README.md", baseline: false }
    tracks:
      - { id: docs, promptFile: w2-docs.md }
YAML

"$C" doctor "$W/manifest.yaml"
"$C" start "$W/manifest.yaml" > "$W/start.json"
cat "$W/start.json"
RUN_DIR="$(node -e "console.log(require('$W/start.json').dir)")"

# watch jak w sesji Claude: od 0, żeby złapać też „start”
"$C" watch "$W/manifest.yaml" --from 0 > "$W/watch.log" &
WATCH=$!

# ubij proces dyrygenta (nie demona), gdy pierwszy tor będzie zielony
until grep -q "ZIELONY" "$RUN_DIR/events.log" 2>/dev/null; do sleep 2; done
CHILD="$(node -e "console.log(require('$W/state/current.json').childPid)")"
echo ">>> SIGKILL procesu dyrygenta $CHILD (demon ma wznowić)"
kill -9 "$CHILD"

wait $WATCH || true
sleep 2
echo; echo "════ ASERCJE ════"
fail=0; ok() { echo "✓ $1"; }; bad() { echo "✗ $1"; fail=1; }
cat "$W/watch.log"
grep -q '^done|' "$W/watch.log" && ok "watch dostał „done”" || bad "watch bez done"
[ "$(grep -c '^wave|' "$W/watch.log")" = 2 ] && ok "dwa powiadomienia o falach" || bad "powiadomienia o falach: $(grep -c '^wave|' "$W/watch.log")"
grep -q "proces dyrygenta padł" "$RUN_DIR/events.log" && ok "demon wznowił po SIGKILL" || bad "brak wznowienia przez demona"
cd "$W/repo"
grep -q "export function add" calc.js && ok "add w main" || bad "brak add"
[ -f README.md ] && ok "fala 2 w main mimo odłożonych torów" || bad "brak README"
[ ! -f BROKEN.txt ] && ok "broken NIE w main" || bad "BROKEN.txt w main"
[ "$(ls slot-*.txt 2>/dev/null | wc -l | tr -d ' ')" = 1 ] && ok "z kolidujących c1/c2 wszedł dokładnie jeden" || bad "sloty: $(ls slot-*.txt 2>/dev/null)"
node --test >/dev/null 2>&1 && ok "testy zielone na main" || bad "testy czerwone"
grep -q "never" "$RUN_DIR/REPORT.md" && grep -q "czerwone już na main" "$RUN_DIR/REPORT.md" && ok "bramka czerwona na main tylko informacyjna (w raporcie)" || bad "brak informacji o bazowo czerwonej bramce"
grep -q "wave|[0-9]*|fala w2.*czerwone już na main" "$W/watch.log" && bad "bramka celu (baseline: false) potraktowana jako informacyjna" || ok "bramka celu fali 2 blokuje (nie informacyjna)"
grep -q "Awaryjne scalanie" "$RUN_DIR/REPORT.md" && ok "raport odnotował awaryjne scalanie" || bad "brak awaryjnego scalania w raporcie"
git branch --format='%(refname:short)' | grep -q "wave/broken" && ok "gałąź odłożonego toru zostaje do obejrzenia" || bad "brak gałęzi wave/broken"
[ "$(git worktree list | wc -l | tr -d ' ')" = 1 ] && ok "worktree posprzątane" || { bad "zostały worktree"; git worktree list; }
pgrep -f "$W/repo-wt/" >/dev/null && bad "żyją procesy w worktree" || ok "brak procesów-sierot"
echo "ℹ raport: $RUN_DIR/REPORT.md"
exit $fail
