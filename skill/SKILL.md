---
name: wave-conductor
description: Run a coding plan through Wave Conductor, monitor execution to completion and report meaningful updates. Use when the owner asks to launch a plan, execute waves automatically, notify them on completion or inspect an active run.
---

# Launch and monitor Wave Conductor

Conductor checkout: `<wave-conductor-checkout>`; command: `<wave-conductor-checkout>/bin/conduct`.
Read `<wave-conductor-checkout>/docs/MANIFEST.md` before preparing a manifest.

The owner delegates plan decisions for the duration of the run. Resolve ambiguity reversibly and record assumptions in manifest comments. If doctor reports a blocking prerequisite that requires the owner, such as a missing authentication key, state the required action and stop.

## Prepare the plan

1. Find the plan directory and read its README, shared rules and every wave file.
2. Identify the repository, starting branch, wave order, independent tracks, branch names, integration prompts, test commands and acceptance criteria. Check commands against the project configuration.
3. If one file describes several tracks, use an inline prompt limiting each track to its section rather than assigning the full file repeatedly.
4. Use `variants` and `judgeCriteria` when both alternatives must be built. For a review checkpoint, let the supervisor decide through AskUserQuestion.
5. Mark essential tracks `required: true`.
6. Put new task acceptance checks in track gates. Put regression checks in wave gates. Set `baseline: false` for new wave-level criteria.
7. Use a trusted comparison adapter and `failuresFile` when existing failing tests must remain visible without hiding new failures. Configure repeated checks only when needed for known noise.
8. Choose a worktreeRoot that inherits project rules, and ports that do not conflict with existing servers.
9. Prefer a separate `policy.outputBranch` for review. Protect committed acceptance criteria with `policy.protectedPaths` while leaving ordinary unit tests editable.
10. Save conductor.yaml in the plan directory, then run `conduct plan` and `conduct check`. Repair validation failures before starting.

## Start

```bash
<wave-conductor-checkout>/bin/conduct doctor <manifest>
<wave-conductor-checkout>/bin/conduct start <manifest>
```

Doctor must have no failed checks. Start returns JSON containing runId, notifyFile and reportFile. The detached daemon survives terminal closure and restarts after crashes.
Tell the owner that execution started, how many waves/tracks it contains and when notifications will arrive. Write status messages and summaries in English.

## Monitor

Use the available monitoring capability with:

```bash
<wave-conductor-checkout>/bin/conduct watch <manifest> --from <N>
```

N is the count of consumed notifyFile lines, usually 1 after the start notification. Each event is `kind|N|message`; retain the latest N to avoid duplicate updates.

- On wave, problem or heartbeat, relay a concise meaningful notification if the host supports it.
- On done or stopped, read REPORT.md and DECISIONS.md. Summarize integrated and deferred work, reasons, baseline warnings, supervisor decisions, estimated cost and report location.
- When monitoring expires without completion, resume from the latest N. Do not notify solely because monitoring timed out.

The conductor also sends configured macOS/ntfy notifications independently of the launching session.

## Status and recovery

Use `conduct status <manifest>` for the live report and daemon status. Stop only when explicitly requested with `conduct stop <manifest>`. Resume with `conduct start <manifest> --resume-last`.
