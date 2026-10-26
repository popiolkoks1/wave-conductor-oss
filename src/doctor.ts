import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { contextBundle, mergePromptOf, trackPrompt, type Manifest } from './manifest.js';
import { Notifier } from './notify.js';
import { cleanEnv, freeGb, sh } from './sh.js';

type Level = 'ok' | 'warn' | 'fail';
interface Check {
  level: Level;
  what: string;
  fix?: string;
}

/** Check prerequisites before a potentially long run so failures surface early. */
export async function doctor(m: Manifest, opts: { auth: boolean; testNotify: boolean; running: boolean; print?: (s: string) => void }): Promise<boolean> {
  const out: Check[] = [];
  const add = (level: Level, what: string, fix?: string) => out.push({ level, what, fix });

  // Plan.
  try {
    contextBundle(m);
    for (const w of m.waves) {
      mergePromptOf(m, w);
      for (const t of w.tracks) trackPrompt(m, t);
    }
    add('ok', `plan: ${m.waves.length} waves, ${m.waves.reduce((n, w) => n + w.tracks.length, 0)} tracks, all prompt files readable`);
  } catch (e: any) {
    add('fail', `plan: ${e.message}`, 'fix promptFile/context paths in the manifest');
  }

  // Repository.
  const g = (a: string) => sh(`git ${a}`, m.repo, 60);
  if (!existsSync(m.repo)) add('fail', `repo ${m.repo} does not exist`);
  else {
    const head = (await g('rev-parse --abbrev-ref HEAD')).out.trim();
    if (head !== m.mainBranch) add('fail', `repository checkout is on „${head}”, but the conductor advances ${m.mainBranch} in this checkout`, `git -C ${m.repo} switch ${m.mainBranch}`);
    else add('ok', `repository on ${m.mainBranch}`);
    const dirty = (await g('status --porcelain --untracked-files=no')).out.trim();
    if (dirty) add('warn', `repository has uncommitted changes in tracked files (${dirty.split('\n').length}) — may block fast-forwarding ${m.mainBranch}`, 'commit or stash them before starting');
    const wts = (await g('worktree list --porcelain')).out.split('\n').filter((l) => l.startsWith('worktree ')).length - 1;
    if (wts > 0) add('warn', `repository has ${wts} other worktrees; they do not prevent execution, but the plan may require their absence`);
    for (const k of ['user.name', 'user.email']) if ((await g(`config --get ${k}`)).code !== 0) add('fail', `git ${k} is not configured; session commits will fail`);
    const sign = (await g('config --get commit.gpgsign')).out.trim() === 'true';
    const fmt = (await g('config --get gpg.format')).out.trim();
    if (sign && fmt === 'ssh') {
      const agent = await sh('ssh-add -l', m.repo, 20);
      if (agent.code !== 0) add('fail', 'SSH commit signing is enabled but ssh-agent has no key; commits may hang on a password prompt', 'ssh-add --apple-use-keychain ~/.ssh/<key>');
      else add('ok', 'SSH signing: key available in agent');
    } else if (sign) add('warn', `commit signing enabled (${fmt || 'gpg'}) — ensure signing does not prompt for a password`);
  }

  // Disk space and directories.
  try {
    mkdirSync(m.worktreeRoot, { recursive: true });
    mkdirSync(m.stateDir, { recursive: true });
    accessSync(m.worktreeRoot, constants.W_OK);
    const gb = await freeGb(m.worktreeRoot);
    // Estimate tracked file size plus 0.6 GB for dependencies; traversing node_modules with du is slow.
    const tracked = await sh(`git ls-files -z | xargs -0 stat -c %s 2>/dev/null | awk '{s+=$1} END {print s+0}'`, m.repo, 120);
    const repoGb = (Number(tracked.out.trim()) || 0) / 1024 ** 3 + 0.6;
    const need = repoGb * (Math.min(m.maxParallel, maxUnits(m)) + 1) + m.minFreeGb;
    if (gb < m.minFreeGb) add('fail', `free ${gb.toFixed(1)} GB < minFreeGb ${m.minFreeGb}`);
    else if (gb < need) add('warn', `free ${gb.toFixed(1)} GB, and ${Math.min(m.maxParallel, maxUnits(m))} worktrees plus integration, each about ~${repoGb.toFixed(1)} GB, require ~${need.toFixed(0)} GB; the conductor will wait for space`, 'reduce maxParallel or free disk space');
    else add('ok', `disk: ${gb.toFixed(0)} GB free (required ~${need.toFixed(0)})`);
  } catch (e: any) {
    add('fail', `working directories: ${e.message}`);
  }

  // Check required tools before a track or gate discovers they are missing.
  const missing: string[] = [];
  for (const tool of m.requires) if ((await sh(`command -v ${tool}`, '/', 20)).code !== 0) missing.push(tool);
  if (m.requires.length) missing.length ? add('fail', `missing from PATH: ${missing.join(', ')}`, 'install tools or update PATH before conduct start (sessions inherit the environment)') : add('ok', `tools: ${m.requires.join(', ')}`);

  if (process.platform === 'win32') {
    const lp = (await sh('git config --get core.longpaths', m.repo, 20)).out.trim();
    if (lp !== 'true') add('warn', 'git core.longpaths is disabled; worktree cleanup may fail on paths longer than 260 characters', 'git config --global core.longpaths true');
  }
  if (m.policy.push) {
    const ls = await sh('git ls-remote --exit-code origin HEAD', m.repo, 45);
    if (ls.code !== 0) add('warn', 'push is enabled, but git ls-remote origin requires authentication; pushing may fail and work will remain local', 'authenticate Git (credential manager / gh auth) or set policy.push: false');
    else add('ok', 'origin is readable without interaction (write permission still required for push)');
  }

  // Power and sleep.
  if (process.platform === 'darwin') {
    const batt = (await sh('pmset -g batt', '/', 20)).out;
    if (!/AC Power/.test(batt)) add('warn', 'Mac is on battery; closing the lid can suspend the run even with caffeinate', 'connect power; keep the lid open without an external display');
    else add('ok', 'AC power connected (keep the lid open without an external display to avoid sleep)');
  }

  if (opts.running) add('fail', 'a run is already active for this manifest', 'conduct status / conduct stop');

  // Model authentication.
  if (opts.auth) {
    try {
      let ok = false;
      let err = '';
      for await (const msg of query({
        prompt: 'Reply with one word: OK',
        options: { model: m.models.supervisor, tools: [], maxTurns: 1, settingSources: [], env: cleanEnv(), cwd: m.planDir },
      }) as AsyncIterable<any>) {
        if (msg.type === 'result') {
          ok = msg.subtype === 'success' && !msg.is_error;
          err = msg.result ?? '';
        }
        if (msg.type === 'rate_limit_event' && msg.rate_limit_info?.status === 'rejected') {
          const at = msg.rate_limit_info.resetsAt;
          add('warn', `subscription limit exhausted${at ? ` until ${new Date(at < 1e12 ? at * 1000 : at).toLocaleTimeString('en-US')}` : ''} — the run will wait before starting`);
        }
      }
      ok ? add('ok', `model ${m.models.supervisor ?? '(default)'} responds`) : add('fail', `model did not respond: ${err.slice(0, 200)}`, 'authenticate Claude Code or set ANTHROPIC_API_KEY');
    } catch (e: any) {
      add('fail', `authentication: ${String(e.message).slice(0, 200)}`, 'authenticate Claude Code or set ANTHROPIC_API_KEY');
    }
  }

  // Notifications.
  const chans = [m.notify.macos && 'macOS', m.notify.ntfy && `ntfy:${m.notify.ntfy}`, m.notify.command && 'command'].filter(Boolean);
  add(chans.length ? 'ok' : 'warn', `notifications: ${chans.join(', ') || 'no channel (notify.jsonl only)'}${m.notify.heartbeatHours ? `, heartbeat every ${m.notify.heartbeatHours} hours of silence` : ''}`);
  if (opts.testNotify) await new Notifier(m.notify, m.stateDir, `Conductor: ${m.name}`).send('start', 'Notification test: this channel is working.');

  const icon = { ok: '✓', warn: '!', fail: '✗' };
  const print = opts.print ?? console.log;
  for (const c of out) print(`${icon[c.level]} ${c.what}${c.fix ? `\n    → ${c.fix}` : ''}`);
  return !out.some((c) => c.level === 'fail');
}

const maxUnits = (m: Manifest) => Math.max(...m.waves.map((w) => w.tracks.reduce((n, t) => n + (t.variants?.length ?? 1), 0)));
