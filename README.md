# Wave Conductor

**Turn a coding plan into tested, integrated commits.**

Wave Conductor runs Claude Code tasks in parallel Git worktrees, checks their results with your commands, and integrates successful changes in stages. It records progress and decisions so interrupted runs can resume.

Have six maintenance tasks and don't want to manage six agent sessions? Describe the tasks, checks and dependencies once, then inspect the resulting branch and report.

```text
Your plan
  Wave 1: API validation ─┐
          documentation ─┴─ checks → integration checks
  Wave 2: usage example ──── checks → result branch + report
```

A **wave** is a stage; a **track** is a task; a **gate** is a command that checks the result. Tasks within a wave run concurrently, up to your configured limit.

## Try it without an AI account

```bash
npm ci
npm run demo
```

The demo creates a temporary Git repository, integrates a prebuilt task through the real conductor and prints a report. No model calls, API key or charges. [Expected report](docs/DEMO-REPORT.md).

## Is this for you?

| Good fit | Less useful |
|---|---|
| Multi-part refactors with automated tests | One small edit |
| Maintenance across independent modules | Tasks that all rewrite the same files |
| Features with explicit acceptance criteria | Work whose correctness has no objective check |

Execution currently uses the Claude Agent SDK. The [quickstart guide](docs/QUICKSTART.md) covers the main workflow and verification controls.

## Start with your project

```bash
bin/conduct init ../my-plan/conductor.yaml --repo /path/to/project
# Edit task prompts, setup commands and test commands.
bin/conduct plan ../my-plan/conductor.yaml
bin/conduct check ../my-plan/conductor.yaml
bin/conduct doctor ../my-plan/conductor.yaml
bin/conduct run ../my-plan/conductor.yaml
```

Generated plans use a separate result branch by default. Review with `git diff main...conductor/my-change` in your project. The source branch stays unchanged. Existing manifests keep their previous main-branch integration behavior. To open a PR after review, push the result branch and use your normal GitHub workflow.

A plan preview runs no agent sessions or test commands. Budget values are estimated limits, not a predicted price. `doctor` checks the environment and, unless `--no-auth` is supplied, invokes a model to check authentication.

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

See [the manifest reference](docs/MANIFEST.md) for dependencies between tasks, variants, model selection, budgets, gates, notifications and optional visual review. The [optional Claude skill](skill/SKILL.md) must be configured with the path to your checkout; no personal installation paths are assumed.

## How it works

1. Measure regression gates on the main branch.
2. Start independent tasks in isolated worktrees, with configurable parallelism, setup commands, models and budgets.
3. Let the supervisor answer task questions from the plan, retry failing gates, and defer tasks that cannot pass. Required tasks stop the run on failure.
4. Integrate successful branches, verify the result, then advance the result branch (or local main for legacy plans) with `--ff-only`. Push is opt-in through `policy.push`.
5. Save `REPORT.md`, `DECISIONS.md` (decisions), logs, notifications and resumable state under `stateDir`.

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

## Evaluate the benefit

Use the [evaluation worksheet](docs/EVALUATION.md) to compare real runs by accepted results, time, estimated cost and human interventions. No speedup or quality benchmark is claimed by the included demo.
