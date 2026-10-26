# Example demo output

Captured from `npm run demo`; commit hashes and timestamps vary. No model sessions are used. The temporary repository and logs are removed after the demo.

```text
# Run report — account-free-demo

- run: `demo`, 2026-10-26 11:59 → 2026-10-26 11:59 (0 min)
- result: **all waves completed**
- conductor/demo: `cfd9216b1d` → `9d8517ee01`
- supervisor decisions: **0** (full list: `DECISIONS.md`)
- estimated cost: $0.00

- running: 0; integrated: 1; deferred: 0
- result branch: conductor/demo
- next action: Review the result diff and any deferred tasks.

## Wave documentation — merged · 0 min

integration gates: ✓ usage 1/1

| track | status | min | commits | gates / reason | cost |
|---|---|---|---|---|---|
| docs | ✓ integrated | — | 1 | completed before the run (done) | $0.00 |

## Manual review

No deferred tracks. Result branch: conductor/demo.

Session logs: `sessions/*.jsonl`, execution timeline: `events.log`.

```
