#!/usr/bin/env node
import { initPlan, describePlan, prepareOutput } from './onboarding.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Conductor } from './conductor.js';
import { doctor } from './doctor.js';
import { loadManifest, type Manifest } from './manifest.js';
import { Notifier } from './notify.js';
import { liveReport, writeReport } from './report.js';
import { git } from './sh.js';
import { Store } from './state.js';

const USAGE = `wave-conductor — autonomous execution of a coding plan

  conduct init <manifest.yaml> [--repo PATH]                   create a starter plan
  conduct plan <manifest.yaml>                                 preview execution without agents
  conduct doctor <manifest.yaml> [--no-auth] [--test-notify]   check prerequisites before execution
  conduct start  <manifest.yaml> [--resume-last]                run in background (survives closing the terminal)
  conduct stop   <manifest.yaml>                                stop background execution (resumable)
  conduct status <manifest.yaml> [runId]                        report and daemon status
  conduct run    <manifest.yaml> [--resume <runId>|--resume-last]  run in foreground
  conduct watch  <manifest.yaml> [--from N]                     stream notifications as kind|N|message (for Claude sessions)
  conduct check  <manifest.yaml>                                validate the manifest and prompt files`;

const CLI = fileURLToPath(import.meta.url);
/** Run Node with tsx in the same process. The tsx executable spawns a child, which would orphan the conductor and its lock when stopped. */
const NODE = process.execPath;
const NODE_ARGS = ['--import', pathToFileURL(join(dirname(CLI), '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, CLI];

const alive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Current {
  runId: string;
  dir: string;
  daemonPid?: number;
  childPid?: number;
  manifest: string;
  notifyFile: string;
  reportFile: string;
}
const currentFile = (m: Manifest) => join(m.stateDir, 'current.json');
const readCurrent = (m: Manifest): Current | undefined => (existsSync(currentFile(m)) ? JSON.parse(readFileSync(currentFile(m), 'utf8')) : undefined);
const writeCurrent = (m: Manifest, c: Current) => {
  mkdirSync(m.stateDir, { recursive: true });
  writeFileSync(currentFile(m), JSON.stringify(c, null, 2));
};
const runs = (m: Manifest) => (existsSync(m.stateDir) ? readdirSync(m.stateDir).filter((f) => /^\d{4}-/.test(f)).sort() : []);
const newRunId = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) return console.log(USAGE);
  if (cmd === 'init') {
    const i = rest.indexOf('--repo');
    console.log(await initPlan(file, i >= 0 ? rest[i + 1] : process.cwd()));
    return;
  }
  const m = loadManifest(file);
  if (cmd === 'plan') return console.log(describePlan(m));
  if (['run', 'start'].includes(cmd)) await prepareOutput(m);

  switch (cmd) {
    case 'check': {
      const { trackPrompt, contextBundle, mergePromptOf } = await import('./manifest.js');
      contextBundle(m);
      for (const w of m.waves) {
        mergePromptOf(m, w);
        for (const t of w.tracks) trackPrompt(m, t);
      }
      await git(m.repo, `rev-parse --verify ${m.mainBranch}`);
      console.log(`OK: ${m.waves.length} waves, ${m.waves.reduce((n, w) => n + w.tracks.length, 0)} tracks, repo ${m.repo}`);
      return;
    }
    case 'doctor': {
      const ok = await doctor(m, { auth: !rest.includes('--no-auth'), testNotify: rest.includes('--test-notify'), running: alive(readCurrent(m)?.daemonPid) });
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'status': {
      const id = rest[0] ?? readCurrent(m)?.runId ?? runs(m).at(-1);
      if (!id) return console.log('No runs found.');
      const store = new Store(m.stateDir, id);
      console.log(writeReport(m, store));
      const cur = readCurrent(m);
      if (cur?.runId === id) console.log(alive(cur.daemonPid) ? `▶ daemon is running (pid ${cur.daemonPid})` : '■ daemon is not running');
      return;
    }
    case 'stop': {
      const cur = readCurrent(m);
      if (!cur || !alive(cur.daemonPid)) return console.log('Nothing is running.');
      process.kill(cur.daemonPid!, 'SIGTERM');
      console.log(`Sent stop signal to daemon ${cur.daemonPid}. Resume: conduct start ${file} --resume-last`);
      return;
    }
    case 'watch':
      return watch(m, rest);
    case 'start':
      return start(m, file, rest);
    case 'daemon':
      return daemon(m, file, rest[0]);
    case 'run':
      return run(m, file, rest);
    default:
      console.log(USAGE);
  }
}

/** Stream kind|N|message for each notify.jsonl entry starting at N. N counts consumed entries, allowing monitoring to resume without duplicates. End on done/stopped or daemon exit. */
async function watch(m: Manifest, rest: string[]) {
  const cur = readCurrent(m);
  if (!cur) return console.log('stopped|0|no run found for this manifest');
  const fi = rest.indexOf('--from');
  let seen = fi >= 0 ? Number(rest[fi + 1]) : -1;
  const lines = () => (existsSync(cur.notifyFile) ? readFileSync(cur.notifyFile, 'utf8').split('\n').filter(Boolean) : []);
  if (seen < 0) seen = lines().length;
  for (;;) {
    const all = lines();
    for (; seen < all.length; seen++) {
      const e = JSON.parse(all[seen]);
      console.log(`${e.kind}|${seen + 1}|${e.message}`);
      if (e.kind === 'done' || e.kind === 'stopped') return;
    }
    if (!alive(readCurrent(m)?.daemonPid) && !alive(readCurrent(m)?.childPid)) {
      const again = lines();
      if (again.length > seen) continue;
      console.log(`stopped|${seen}|conductor daemon is not running and the run has not reported completion — conduct status / conduct start --resume-last`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** Start a daemon detached from the terminal and the Claude session that launched it. */
async function start(m: Manifest, file: string, rest: string[]) {
  const cur = readCurrent(m);
  if (cur && alive(cur.daemonPid)) {
    console.log(`Run ${cur.runId} is already running (daemon ${cur.daemonPid}). Notifications: ${cur.notifyFile}`);
    return;
  }
  // Send doctor output to stderr; start stdout remains machine-readable JSON.
  const ok = await doctor(m, { auth: !rest.includes('--no-auth'), testNotify: false, running: false, print: console.error });
  if (!ok) {
    console.error('\nRun did NOT start. Fix the failed checks above.');
    process.exitCode = 1;
    return;
  }
  const runId = rest.includes('--resume-last') ? (cur?.runId ?? runs(m).at(-1)) : newRunId();
  if (!runId) throw new Error('There is no run to resume.');
  const dir = join(m.stateDir, runId);
  mkdirSync(dir, { recursive: true });
  const out = openSync(join(dir, 'daemon.log'), 'a');
  const child = spawn(NODE, [...NODE_ARGS, 'daemon', resolve(file), runId], { detached: true, stdio: ['ignore', out, out], cwd: m.baseDir });
  child.unref();
  const c: Current = { runId, dir, daemonPid: child.pid, manifest: resolve(file), notifyFile: join(dir, 'notify.jsonl'), reportFile: join(dir, 'REPORT.md') };
  writeCurrent(m, c);
  console.log(JSON.stringify(c, null, 2));
}

/** Restart a crashed conductor from persisted state; exit after completion. */
async function daemon(m: Manifest, file: string, runId: string) {
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  const onStop = () => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  if (process.platform === 'win32') process.on('SIGBREAK', () => {}); // See run(): sessions can send CTRL_BREAK.
  if (process.platform === 'darwin') spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();

  for (let crash = 0; ; ) {
    child = spawn(NODE, [...NODE_ARGS, 'run', file, '--resume', runId, '--from-daemon'], { stdio: 'inherit', cwd: m.baseDir });
    writeCurrent(m, { ...readCurrent(m)!, childPid: child.pid });
    const code: number = await new Promise((r) => child!.on('exit', (c) => r(c ?? 1)));
    if (stopping || code === 0 || code === 2 || code === 3) break;
    crash++;
    const store = new Store(m.stateDir, runId);
    const notifier = new Notifier(m.notify, store.dir, `Conductor: ${m.name}`);
    if (crash > 5) {
      await notifier.send('stopped', `conductor crashed ${crash} times consecutively; stopped. Log: ${join(store.dir, 'daemon.log')}`);
      break;
    }
    store.log(`daemon: conductor process crashed (code ${code}) — restarting in 1 min (${crash}/5)`);
    if (crash === 1) await notifier.send('problem', `conductor process crashed (code ${code}) — restarting automatically`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function run(m: Manifest, file: string, rest: string[]) {
  const ri = rest.indexOf('--resume');
  const runId = rest.includes('--resume-last') ? runs(m).at(-1) : ri >= 0 ? rest[ri + 1] : newRunId();
  if (!runId) throw new Error('There is no run to resume.');
  const fromDaemon = rest.includes('--from-daemon');

  const startMain = await git(m.repo, `rev-parse ${m.mainBranch}`);
  let fresh = false;
  const store = new Store(m.stateDir, runId, () => {
    fresh = true;
    return {
      runId,
      manifest: resolve(file),
      startedAt: new Date().toISOString(),
      startMain,
      waves: m.waves.map((w) => ({ id: w.id, status: 'pending' })),
      tracks: {},
      decisions: 0,
      costUsd: 0,
    };
  });
  // Append newly added waves in manifest order when resuming an existing run.
  const known = new Map(store.state.waves.map((w) => [w.id, w]));
  const added = m.waves.filter((w) => !known.has(w.id)).map((w) => w.id);
  const dropped = store.state.waves.filter((w) => !m.waves.some((x) => x.id === w.id) && w.status !== 'merged').map((w) => w.id);
  if (dropped.length) throw new Error(`Manifest is missing unmerged waves from the run: ${dropped.join(', ')} — cannot resume`);
  if (added.length) {
    store.state.waves = m.waves.map((w) => known.get(w.id) ?? { id: w.id, status: 'pending' as const });
    if (store.state.outcome === 'done') delete store.state.outcome;
    store.save();
    store.log(`manifest: new waves ${added.join(', ')} added to the run`);
  }
  if (store.state.outcome === 'done') {
    console.log(`Run ${runId} has already completed.`);
    return;
  }

  // Only one conductor may own a run; concurrent writers would corrupt worktrees and branches.
  const lock = join(store.dir, 'lock');
  if (existsSync(lock) && alive(Number(readFileSync(lock, 'utf8')))) throw new Error(`Run ${runId} is already managed by pid ${readFileSync(lock, 'utf8')}`);
  writeFileSync(lock, String(process.pid));

  delete store.state.outcome;
  delete store.state.stopReason;
  delete store.state.finishedAt;
  if (!fromDaemon) {
    writeCurrent(m, { runId, dir: store.dir, daemonPid: process.pid, manifest: resolve(file), notifyFile: join(store.dir, 'notify.jsonl'), reportFile: join(store.dir, 'REPORT.md') });
    if (process.platform === 'darwin') spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
  }

  const notifier = new Notifier(m.notify, store.dir, `Conductor: ${m.name}`);
  // Keep REPORT.md and conduct status up to date during execution.
  store.onChange = liveReport(m, store);
  const conductor = new Conductor(m, store, notifier);
  const finish = async (code: number) => {
    const report = writeReport(m, store);
    const s = store.state;
    const merged = Object.values(s.tracks).filter((t) => t.status === 'merged').length;
    const deferred = Object.values(s.tracks).filter((t) => t.status === 'deferred').length;
    if (s.outcome === 'done') await notifier.send('done', `ALL WAVES COMPLETE (${s.waves.length}): integrated ${merged} tracks, deferred ${deferred}, decisions ${s.decisions}, ~$${s.costUsd.toFixed(0)}. Report: REPORT.md`);
    else await notifier.send('stopped', `run STOPPED: ${s.stopReason?.slice(0, 140)}`);
    console.log('\n' + report + `\nReport: ${join(store.dir, 'REPORT.md')}`);
    rmSync(lock, { force: true });
    process.exit(code);
  };
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    store.state.outcome = 'stopped';
    store.state.stopReason = 'stopped manually (conduct stop) — resume: conduct start … --resume-last';
    store.state.finishedAt = new Date().toISOString();
    store.save();
    void finish(3);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  // Windows sessions share the run console; terminating background processes can send CTRL_BREAK to the console group.
  // Without a handler, Node exits with 0xC000013A (observed three times in two hours on 2026-10-02).
  if (process.platform === 'win32') process.on('SIGBREAK', () => store.log('ignored console SIGBREAK (Windows)'));

  store.log(`▶ run ${runId} — ${m.name}, ${m.waves.length} waves, state in ${store.dir}`);
  if (fresh) await notifier.send('start', `start: ${m.waves.length} waves, ${m.waves.reduce((n, w) => n + w.tracks.length, 0)} tracks. Next notification after the first wave.`);
  await conductor.run();
  if (!stopping) await finish(store.state.outcome === 'done' ? 0 : 2);
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
