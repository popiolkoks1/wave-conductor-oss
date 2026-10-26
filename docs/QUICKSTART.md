# From plan to reviewed changes

1. Install Node 22+, Git, Bash and project dependencies. Authenticate Claude Code or set ANTHROPIC_API_KEY.
2. Run `conduct init /path/to/plan.yaml --repo /path/to/repository`. Existing files are never overwritten.
3. Replace the task prompt with a concrete change and acceptance criteria. Configure setup and gates for your language. The starter uses `npm test`; replace it for non-Node projects.
4. Use `conduct plan /path/to/plan.yaml` to inspect stages, dependencies, concurrency, checks, budget limits and output branch without execution.
5. Run `conduct check`, `conduct doctor`, then `conduct run` with the same manifest.
6. Inspect REPORT.md, decisions and the result diff. Deferred tasks require manual review even when all waves completed.

## Result branch

```yaml
policy:
  outputBranch: conductor/my-change
  push: false
```

The runner creates `<worktreeRoot>/_result`, based on `mainBranch`, and advances the output branch there. Your source checkout stays on its original branch. Keep this checkout for resuming. A pre-existing output branch outside that checkout is rejected. Use a distinct output branch/worktreeRoot per independent plan. Do not edit the result checkout while execution is running. Push is opt-in and targets the output branch.

## Compare existing failures

```yaml
waves:
  - id: implementation
    gates:
      - name: tests
        run: node scripts/check-tests.mjs
        failuresFile: failures.json
    tracks:
      - id: change
        prompt: Implement the change, add tests and commit.
```

Your command must freshly write a JSON array of stable failing test IDs on every invocation (including `[]` on success). It must exit nonzero when tests fail. The conductor records the baseline IDs before the wave and blocks new IDs during task and integration checks. Missing or malformed reports fail closed. Nonzero exit with an empty failure list is an infrastructure failure. Reports from the previous invocation are removed before running the command. Use a dedicated generated file, never a source file.

Without failuresFile, legacy baseline behavior remains: a gate already red at baseline is informational for that wave. Comparison is only as trustworthy as your test adapter and stable IDs; it does not detect a weakened assertion with the same ID. For flaky repeated checks, prefer deterministic adapters; the last observed failure list is retained as baseline evidence.

## Protect acceptance criteria

```yaml
policy:
  protectedPaths:
    - acceptance/
    - scripts/check-tests.mjs
```

These are Git pathspecs. The conductor checks committed changes after tasks and during integration, including changes made through shell commands. A modified protected path blocks integration. Use acceptance tests committed before the run; keep editable unit tests separate so agents can add regression coverage. This is an integrity check, not an OS sandbox. Existing denyPaths hooks remain available for edit-time restrictions.

## Progress and recovery

`conduct status plan.yaml` prints counts, result branch, task reasons, estimated costs and a next action. `conduct watch plan.yaml --from 0` streams notifications. `conduct stop plan.yaml` stops background execution; `conduct start plan.yaml --resume-last` resumes it.

REPORT.md and DECYZJE.md preserve evidence and decisions; sessions/*.jsonl contains agent logs. Review deferred tasks and baseline warnings before accepting results.
