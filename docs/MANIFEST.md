# Manifest reference

The manifest is a YAML file. Relative paths resolve from its directory; `~` expands to the user's home directory. `promptFile`, `context` and `mergePromptFile` resolve from `planDir`.

## Main fields

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Run name used in reports and notifications. |
| `repo` | required | Project Git checkout. With legacy main integration, it must be on `mainBranch`. With `policy.outputBranch`, results use a dedicated checkout. |
| `planDir` | required | Directory containing task prompts, context and integration prompts. |
| `mainBranch` | `main` | Starting branch and integration target unless `outputBranch` is set. |
| `context` | `[]` | Plan files read by the supervisor and each session at startup. |
| `worktreeRoot` | `<repo>-conductor-wt` | Track and integration worktree directory. Place under a directory providing project CLAUDE.md and `.claude` rules when inheritance is required. |
| `stateDir` | `.conductor` | Run state under `<stateDir>/<runId>/`, plus `current.json`. |
| `sessionCwd` | worktree | Session startup directory, for example to load project hooks. Work still happens in the assigned worktree. |
| `mergePort` | `basePort + 90` | Integration session dev server port. |
| `setup` | `[]` | Commands run in every new worktree, for example `cd frontend && pnpm install --frozen-lockfile`. |
| `basePort` | `4100` | Track N in a wave uses port `basePort + N`. |
| `maxParallel` | `4` | Maximum concurrent tracks; must be a positive integer. |
| `maxFixAttempts` | `3` | Gate repair attempts before deferring a track. |
| `maxFollowUps` | `4` | Supervisor replies to sessions ending with plain-text questions. |
| `maxTurns` | unset | Per-session turn limit. |
| `maxBudgetUsd` | unset | Estimated SDK cost limit per session. |
| `maxRunBudgetUsd` | unset | Estimated run cost limit. Once reached, no new tracks start and execution ends with a report. |
| `sessionTimeoutMin` | `240` | Wall-clock timeout; interrupt and resume the session with guidance. |
| `minFreeGb` | `10` | Wait rather than create a worktree below this free-space threshold. |
| `mainBusyWaitMin` | `120` | Maximum wait for disk space or an available main checkout. |
| `settingSources` | `[project, local]` | Claude Code settings loaded by sessions, including project hooks. |
| `models` | SDK default | Model IDs for `track`, `supervisor`, `merge`, `judge`, `reviewer` and `light`. Reviewer defaults to judge; light defaults to supervisor. |
| `requires` | `[]` | Tools required on PATH; checked by doctor, for example `[node, pnpm, make, cargo]`. |
| `review` | unset | Optional independent visual review; see below. |
| `earlyPortOffset` | `50` | Early track port offset: `basePort + offset + (wave index % 4) × 10 + track index`. |
| `notify` | `{macos: true, heartbeatHours: 6}` | Notification channels and heartbeat interval. |
| `policy` | see below | Push behavior, output branch and restrictions. |
| `waves` | required | Nonempty list of execution stages. |

## Notifications

| Field | Meaning |
|---|---|
| `macos` | macOS Notification Center. |
| `ntfy` | ntfy.sh topic for phone notifications. Subscribe in the ntfy app; treat the topic as a secret. |
| `command` | Custom command receiving `$CONDUCTOR_KIND` and `$CONDUCTOR_MESSAGE`, for example a webhook command. |
| `heartbeatHours` | Send a heartbeat after this many hours without a notification; `0` disables it. |

Notifications are intentionally infrequent: start, completion of each wave, run completion or stop, environment problems (disk space, occupied checkout, rate limit wait, process crash) and occasional heartbeats. Every notification is also saved to `<run>/notify.jsonl`, read by `conduct watch`.

## Policy

| Field | Default | Meaning |
|---|---|---|
| `push` | `false` | Push the integration target to origin after each merged wave; never force-push. |
| `outputBranch` | unset | Keep the source branch unchanged. Create this result branch from `mainBranch` in `<worktreeRoot>/_result` and integrate successive waves there. |
| `denyBash` | `[]` | Additional forbidden shell command regexes, such as `tools/publish` or `deploy`. |
| `writeRoots` | `[]` | Directories where sessions may write outside their own worktree. |
| `denyPaths` | `[]` | Paths relative to the worktree blocked by tool hooks, such as `math/` or `src/types/`. |
| `protectedPaths` | `[]` | Git pathspecs whose committed modifications block task acceptance and integration, including edits made through shell commands. |

Use a separate `outputBranch` and `worktreeRoot` for each independent plan. Keep the result checkout for resuming; pre-existing branches outside it are rejected. Push targets the result branch when configured. Existing manifests without `outputBranch` retain main-branch integration.

Commit protected acceptance tests before the run and leave ordinary regression tests editable. Restrictions are guardrails, not an OS security sandbox.

## Visual review

The conductor launches the server in the worktree, waits for HTTP 200, runs the screenshot command and terminates the server. The reviewer receives screenshots and criteria without track reports or self-assessments.

| Field | Meaning |
|---|---|
| `serve` | Background server command; the conductor substitutes `{port}`. |
| `ready` | Readiness path returning HTTP 200; defaults to `/`. |
| `showcase` | Screenshot command; substitutes `{url}` and `{out}`. Write PNGs with stable names into `{out}` so before/after images can be paired. |
| `instructions` | Project-specific reviewer role and requirements. No industry or aesthetic is imposed by default. |
| `criteria` | Criteria files relative to `planDir` or absolute paths, such as product and accessibility checklists. |
| `judge` | Judge variants using screenshots rather than self-assessments; defaults to `true`. |
| `wave` | Review after integration, with a 0–3 star rating. A `fix` verdict allows one integration-session repair round, reverted if it breaks gates. Defaults to `true`. |
| `port` | Showcase server port; defaults to `mergePort + 5`. |

Output: `<run>/showcase/<wave>.html`, a before/after page with review. Ratings also appear in REPORT.md and wave notifications. REPORT.md updates during execution, at most every 15 seconds, with track and wave durations. Screenshots do not prove behavior or full accessibility.

## Wave

| Field | Meaning |
|---|---|
| `id` | Wave ID; integration branch is `integration/<id>`. |
| `tracks` | Tasks normally starting from the result of the previous wave. |
| `gates` | Checks for every track, in addition to track-specific gates. |
| `integrationGates` | Checks after merging; defaults to `gates`. |
| `mergePromptFile` / `mergePrompt` | Optional integration prompt. Without one, the conductor merges automatically and asks a session to resolve conflicts. |

## Track

| Field | Meaning |
|---|---|
| `id` | Track ID, unique across the manifest. |
| `promptFile` / `prompt` | Task prompt file or inline task. |
| `branch` | Branch name; defaults to `wave/<id>`. If occupied by unmerged work, a suffix such as `-r2` is used. |
| `base` | Starting ref other than the integration target. |
| `required` | Stop the run if this track fails, instead of proceeding without it. |
| `variants` | `[{id, note}]`; each variant runs in its own worktree. The judge chooses a winner; alternative branches remain as `<branch>--<id>`. |
| `judgeCriteria` | Criteria for choosing a variant. |
| `gates` | Track-specific acceptance checks. |
| `model` | Model override for this track. |
| `done` | Already-completed local or origin branch. Skip the session and send it to integration. Useful for partially completed plans. |
| `dir` | Worktree directory name under `worktreeRoot`. |
| `port` | Explicit dev server port. |
| `denyPaths` | Additional frozen paths for this track. |
| `needs` | Track IDs from earlier waves. When dependencies pass and variants are resolved, start early from `prestart/<id>`: current target plus dependency branches. If a dependency is later excluded from integration, defer this track to avoid reintroducing it. Without `needs`, wait for the previous wave. |

## Gate

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Report label and baseline comparison identity. `protected-paths` is reserved. |
| `run` | required | Shell command; exit code 0 passes. |
| `cwd` | `.` | Directory relative to the worktree. |
| `runs` / `mustPass` | `1` / `runs` | Repeated checks pass when at least `mustPass` attempts succeed. |
| `timeoutSec` | `1800` | Timeout per attempt. |
| `baseline` | `true` | Wave/integration gates only. Set `false` for a new acceptance criterion that cannot pass on the starting branch. |
| `failuresFile` | unset | Generated JSON array of stable failing test IDs, relative to gate cwd. Enables comparison against baseline failures. |

Track gates check task goals and always block. Wave/integration gates normally check regressions and are measured on the clean starting branch before each wave. A new wave-level criterion needs `baseline: false`; otherwise a failing baseline can make it informational.

Without `failuresFile`, a gate already failing at baseline does not block that wave and is marked `◌`. To compare detailed results yourself, use a script returning 0/1.

With `failuresFile`, the command must freshly write a JSON string array on every invocation, including `[]` on success, and exit nonzero on failed tests. Previously failing IDs are allowed; new failures block. Missing or malformed reports and nonzero exit with an empty failure list fail closed. The report is removed before each invocation; use a dedicated generated file. Comparison depends on stable IDs and a trustworthy adapter; it cannot identify weakened assertions with unchanged IDs. For repeated checks, the last observed failure list is retained as baseline evidence.

## Commands and run artifacts

- `conduct init <manifest> --repo <repo>` creates a starter without overwriting an existing file.
- `conduct plan <manifest>` previews stages, dependencies, checks, budgets and target without models or test execution.
- `conduct check <manifest>` validates the plan and prompt paths.
- `conduct doctor <manifest>` checks prerequisites; `--no-auth` skips its model authentication probe.
- `conduct run <manifest>` runs in foreground; `start` runs detached.
- `conduct status <manifest>`, `watch`, `stop` and `start --resume-last` inspect, stop and resume execution.

New runs write decisions to DECISIONS.md. On first write when resuming an older run, a legacy DECYZJE.md is copied into DECISIONS.md so existing context is preserved. Existing logs are not translated retroactively. See the [quickstart](QUICKSTART.md) for examples.
