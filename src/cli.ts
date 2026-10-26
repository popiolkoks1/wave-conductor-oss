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

const USAGE = `wave-conductor — autonomiczny przebieg fal planu

  conduct init <manifest.yaml> [--repo PATH]                   create a starter plan
  conduct plan <manifest.yaml>                                 preview execution without agents
  conduct doctor <manifest.yaml> [--no-auth] [--test-notify]   sprawdza wszystko, co może wywrócić przebieg
  conduct start  <manifest.yaml> [--resume-last]                przebieg w tle (przeżyje zamknięcie terminala)
  conduct stop   <manifest.yaml>                                zatrzymuje przebieg w tle (da się wznowić)
  conduct status <manifest.yaml> [runId]                        raport + czy demon żyje
  conduct run    <manifest.yaml> [--resume <runId>|--resume-last]  przebieg na pierwszym planie
  conduct watch  <manifest.yaml> [--from N]                     nowe powiadomienia jako linie „rodzaj|N|treść” (dla sesji Claude)
  conduct check  <manifest.yaml>                                walidacja manifestu i plików promptów`;

const CLI = fileURLToPath(import.meta.url);
/**
 * Node z loaderem tsx w TYM SAMYM procesie — binarka `tsx` odpala node jako dziecko, więc zabicie jej
 * (demon, stop) osierocałoby właściwego dyrygenta razem z blokadą przebiegu.
 */
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
      console.log(`OK: ${m.waves.length} fal, ${m.waves.reduce((n, w) => n + w.tracks.length, 0)} torów, repo ${m.repo}`);
      return;
    }
    case 'doctor': {
      const ok = await doctor(m, { auth: !rest.includes('--no-auth'), testNotify: rest.includes('--test-notify'), running: alive(readCurrent(m)?.daemonPid) });
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'status': {
      const id = rest[0] ?? readCurrent(m)?.runId ?? runs(m).at(-1);
      if (!id) return console.log('Brak przebiegów.');
      const store = new Store(m.stateDir, id);
      console.log(writeReport(m, store));
      const cur = readCurrent(m);
      if (cur?.runId === id) console.log(alive(cur.daemonPid) ? `▶ demon żyje (pid ${cur.daemonPid})` : '■ demon nie działa');
      return;
    }
    case 'stop': {
      const cur = readCurrent(m);
      if (!cur || !alive(cur.daemonPid)) return console.log('Nic nie działa.');
      process.kill(cur.daemonPid!, 'SIGTERM');
      console.log(`Wysłano stop do demona ${cur.daemonPid}. Wznowienie: conduct start ${file} --resume-last`);
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

/**
 * Strumień powiadomień dla sesji Claude (Monitor): jedna linia `rodzaj|N|treść` na wpis notify.jsonl od numeru N
 * (N = ile przeczytano — po wygaśnięciu Monitora wznawia się od niego bez powtórek). Kończy się na done/stopped
 * albo gdy demon zniknie bez słowa.
 */
async function watch(m: Manifest, rest: string[]) {
  const cur = readCurrent(m);
  if (!cur) return console.log('stopped|0|brak przebiegu dla tego manifestu');
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
      console.log(`stopped|${seen}|demon dyrygenta nie działa, a przebieg nie zgłosił końca — conduct status / conduct start --resume-last`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** Odpala demona odłączonego od terminala i od sesji Claude, która go uruchomiła. */
async function start(m: Manifest, file: string, rest: string[]) {
  const cur = readCurrent(m);
  if (cur && alive(cur.daemonPid)) {
    console.log(`Przebieg ${cur.runId} już trwa (demon ${cur.daemonPid}). Powiadomienia: ${cur.notifyFile}`);
    return;
  }
  // raport doctora na stderr — stdout `start` to czysty JSON dla sesji Claude
  const ok = await doctor(m, { auth: !rest.includes('--no-auth'), testNotify: false, running: false, print: console.error });
  if (!ok) {
    console.error('\nPrzebieg NIE wystartował — napraw pozycje ✗ powyżej.');
    process.exitCode = 1;
    return;
  }
  const runId = rest.includes('--resume-last') ? (cur?.runId ?? runs(m).at(-1)) : newRunId();
  if (!runId) throw new Error('Nie ma czego wznawiać.');
  const dir = join(m.stateDir, runId);
  mkdirSync(dir, { recursive: true });
  const out = openSync(join(dir, 'daemon.log'), 'a');
  const child = spawn(NODE, [...NODE_ARGS, 'daemon', resolve(file), runId], { detached: true, stdio: ['ignore', out, out], cwd: m.baseDir });
  child.unref();
  const c: Current = { runId, dir, daemonPid: child.pid, manifest: resolve(file), notifyFile: join(dir, 'notify.jsonl'), reportFile: join(dir, 'REPORT.md') };
  writeCurrent(m, c);
  console.log(JSON.stringify(c, null, 2));
}

/** Pilnuje przebiegu: po awarii procesu wznawia go (stan jest na dysku), po zakończeniu kończy się sam. */
async function daemon(m: Manifest, file: string, runId: string) {
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  const onStop = () => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  if (process.platform === 'win32') process.on('SIGBREAK', () => {}); // patrz run(): CTRL_BREAK od sesji
  if (process.platform === 'darwin') spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();

  for (let crash = 0; ; ) {
    child = spawn(NODE, [...NODE_ARGS, 'run', file, '--resume', runId, '--from-daemon'], { stdio: 'inherit', cwd: m.baseDir });
    writeCurrent(m, { ...readCurrent(m)!, childPid: child.pid });
    const code: number = await new Promise((r) => child!.on('exit', (c) => r(c ?? 1)));
    if (stopping || code === 0 || code === 2 || code === 3) break;
    crash++;
    const store = new Store(m.stateDir, runId);
    const notifier = new Notifier(m.notify, store.dir, `Dyrygent: ${m.name}`);
    if (crash > 5) {
      await notifier.send('stopped', `dyrygent padł ${crash}× z rzędu — przerwane. Log: ${join(store.dir, 'daemon.log')}`);
      break;
    }
    store.log(`demon: proces dyrygenta padł (kod ${code}) — wznawiam za 1 min (${crash}/5)`);
    if (crash === 1) await notifier.send('problem', `proces dyrygenta padł (kod ${code}) — wznawiam sam`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function run(m: Manifest, file: string, rest: string[]) {
  const ri = rest.indexOf('--resume');
  const runId = rest.includes('--resume-last') ? runs(m).at(-1) : ri >= 0 ? rest[ri + 1] : newRunId();
  if (!runId) throw new Error('Nie ma czego wznawiać.');
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
  // Manifest mógł dostać nowe fale od startu (np. fala poprawek właściciela) — dopisz je do stanu, w kolejności manifestu.
  const known = new Map(store.state.waves.map((w) => [w.id, w]));
  const added = m.waves.filter((w) => !known.has(w.id)).map((w) => w.id);
  const dropped = store.state.waves.filter((w) => !m.waves.some((x) => x.id === w.id) && w.status !== 'merged').map((w) => w.id);
  if (dropped.length) throw new Error(`Manifest nie ma już niescalonych fal z przebiegu: ${dropped.join(', ')} — nie wznawiam`);
  if (added.length) {
    store.state.waves = m.waves.map((w) => known.get(w.id) ?? { id: w.id, status: 'pending' as const });
    if (store.state.outcome === 'done') delete store.state.outcome;
    store.save();
    store.log(`manifest: nowe fale ${added.join(', ')} dopisane do przebiegu`);
  }
  if (store.state.outcome === 'done') {
    console.log(`Przebieg ${runId} już się zakończył.`);
    return;
  }

  // Jeden dyrygent na przebieg — drugi proces na tym samym stanie rozwaliłby worktree i gałęzie.
  const lock = join(store.dir, 'lock');
  if (existsSync(lock) && alive(Number(readFileSync(lock, 'utf8')))) throw new Error(`Przebieg ${runId} jest już prowadzony przez pid ${readFileSync(lock, 'utf8')}`);
  writeFileSync(lock, String(process.pid));

  delete store.state.outcome;
  delete store.state.stopReason;
  delete store.state.finishedAt;
  if (!fromDaemon) {
    writeCurrent(m, { runId, dir: store.dir, daemonPid: process.pid, manifest: resolve(file), notifyFile: join(store.dir, 'notify.jsonl'), reportFile: join(store.dir, 'REPORT.md') });
    if (process.platform === 'darwin') spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
  }

  const notifier = new Notifier(m.notify, store.dir, `Dyrygent: ${m.name}`);
  // Raport na żywo: REPORT.md i `conduct status` pokazują stan w trakcie, nie dopiero po końcu.
  store.onChange = liveReport(m, store);
  const conductor = new Conductor(m, store, notifier);
  const finish = async (code: number) => {
    const report = writeReport(m, store);
    const s = store.state;
    const merged = Object.values(s.tracks).filter((t) => t.status === 'merged').length;
    const deferred = Object.values(s.tracks).filter((t) => t.status === 'deferred').length;
    if (s.outcome === 'done') await notifier.send('done', `WSZYSTKIE FALE GOTOWE (${s.waves.length}): scalono ${merged} torów, odłożono ${deferred}, decyzji ${s.decisions}, ~$${s.costUsd.toFixed(0)}. Raport: REPORT.md`);
    else await notifier.send('stopped', `przebieg ZATRZYMANY: ${s.stopReason?.slice(0, 140)}`);
    console.log('\n' + report + `\nRaport: ${join(store.dir, 'REPORT.md')}`);
    rmSync(lock, { force: true });
    process.exit(code);
  };
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    store.state.outcome = 'stopped';
    store.state.stopReason = 'zatrzymany ręcznie (conduct stop) — wznowienie: conduct start … --resume-last';
    store.state.finishedAt = new Date().toISOString();
    store.save();
    void finish(3);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  // Windows: sesje dzielą z przebiegiem konsolę; ubijając swoje procesy w tle wysyłają CTRL_BREAK do całej
  // grupy konsoli. Bez obsługi Node kończy się wtedy kodem 0xC000013A (zmierzone 2026-10-02, 3 razy w 2 h).
  if (process.platform === 'win32') process.on('SIGBREAK', () => store.log('zignorowano SIGBREAK z konsoli (Windows)'));

  store.log(`▶ przebieg ${runId} — ${m.name}, ${m.waves.length} fal, stan w ${store.dir}`);
  if (fresh) await notifier.send('start', `start: ${m.waves.length} fal, ${m.waves.reduce((n, w) => n + w.tracks.length, 0)} torów. Następne powiadomienie po pierwszej fali.`);
  await conductor.run();
  if (!stopping) await finish(store.state.outcome === 'done' ? 0 : 2);
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
