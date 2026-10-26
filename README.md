# Wave Conductor

Run a coding plan as waves of parallel tasks. Each task gets a Git worktree and a Claude Code session; configurable shell commands verify the work before integration. Runs keep state, session logs and decision reports so they can resume after interruption.

Best suited to multi-part refactors, feature work, maintenance and documentation in Git repositories with reliable automated checks. It works with different languages and build systems: gates and worktree setup are ordinary shell commands. Optional screenshot reviews suit web interfaces. Tasks without an objective check or with tightly overlapping edits need more careful planning.

The execution backend currently uses the Claude Agent SDK. This is not a provider-independent runner. Agent prompts and detailed manifest documentation are currently in Polish; task prompts can use your project's language.

## Requirements and setup

- Node.js 22 or newer, npm, Git and Bash. On Windows, install Git Bash (or set `CONDUCT_SHELL`).
- Claude Code authentication or `ANTHROPIC_API_KEY`, with access to the configured models.
- Your project's own tools and dependencies.

```bash
git clone https://github.com/popiolkoks1/wave-conductor-oss.git
cd wave-conductor-oss
npm ci
# Configure the example paths before running checks.
```

Copy [examples/project.yaml](examples/project.yaml) into a plan directory, set `repo` to a clean Git checkout on its main branch, and replace the prompts and gates with your actual tasks and commands. Paths are relative to the manifest; `promptFile` and `context` are relative to `planDir`.

```bash
bin/conduct check /path/to/plan/conductor.yaml
bin/conduct doctor /path/to/plan/conductor.yaml
bin/conduct run /path/to/plan/conductor.yaml
# Alternatively, detach and monitor:
bin/conduct start /path/to/plan/conductor.yaml
bin/conduct status /path/to/plan/conductor.yaml
bin/conduct watch /path/to/plan/conductor.yaml --from 0
bin/conduct stop /path/to/plan/conductor.yaml
bin/conduct start /path/to/plan/conductor.yaml --resume-last
```

See [the manifest reference (Polish)](docs/MANIFEST.md) for dependencies between tasks, variants, model selection, budgets, gates, notifications and optional visual review. The [optional Claude skill](skill/SKILL.md) must be configured with the path to your checkout; no personal installation paths are assumed.

## How it works

1. Measure regression gates on the main branch.
2. Start independent tasks in isolated worktrees, with configurable parallelism, setup commands, models and budgets.
3. Let the supervisor answer task questions from the plan, retry failing gates, and defer tasks that cannot pass. Required tasks stop the run on failure.
4. Integrate successful branches, verify the result, then advance the local main branch with `--ff-only`. Push is opt-in through `policy.push`.
5. Save `REPORT.md`, `DECYZJE.md` (decisions), logs, notifications and resumable state under `stateDir`.

The supervisor makes decisions autonomously. Use explicit acceptance criteria and a disposable checkout for the first run. Sessions execute code and shell commands with your account's permissions; command filters are guardrails, not a security sandbox. Review untrusted plans and dependencies before running. Run/session budgets estimate SDK costs and are not billing guarantees. Smoke tests invoke real agent sessions and may incur charges.

Visual review is optional. Its default rubric checks interface clarity, completeness and regressions. Set `review.instructions` and `review.criteria` for your product's requirements; screenshots alone cannot verify behavior or full accessibility.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run smoke             # real agent sessions
npm run smoke:resilience  # real agent sessions, crash/recovery scenarios
```

The package is marked private to prevent accidental npm publication. Source use and modification are allowed under the [MIT license](LICENSE). The public repository starts with a clean source snapshot.

A GitHub Actions template is in `docs/ci-workflow.yml.example`. To enable hosted checks, copy it to `.github/workflows/ci.yml` using credentials with workflow permission.
