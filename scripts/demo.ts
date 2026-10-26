import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeManifest } from '../src/manifest.js';
import { Conductor } from '../src/conductor.js';
import { Store } from '../src/state.js';
import { Notifier } from '../src/notify.js';
import { writeReport } from '../src/report.js';
import { prepareOutput } from '../src/onboarding.js';
const root = mkdtempSync(join(tmpdir(), 'conductor-demo-'));
const repo = join(root, 'repo'); mkdirSync(repo);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  git('init', '-b', 'main'); git('config', 'user.name', 'Demo'); git('config', 'user.email', 'demo@example.invalid'); git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'Demo project\n'); git('add', 'README.md'); git('commit', '-m', 'initial');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'demo/docs'); writeFileSync(join(repo, 'USAGE.md'), 'Run the project checks before integration.\n'); git('add', 'USAGE.md'); git('commit', '-m', 'Document usage'); git('switch', 'main');
  const m = normalizeManifest({ name: 'account-free-demo', repo, planDir: root, stateDir: join(root, 'state'), worktreeRoot: join(root, 'wt'), minFreeGb: 0, notify: { macos: false, heartbeatHours: 0 }, policy: { outputBranch: 'conductor/demo' }, waves: [{ id: 'documentation', gates: [{ name: 'readme', run: 'test -s README.md' }], integrationGates: [{ name: 'usage', run: 'test -s USAGE.md', baseline: false }], tracks: [{ id: 'docs', branch: 'demo/docs', done: true }] }] }, root);
  await prepareOutput(m);
  const store = new Store(m.stateDir, 'demo', () => ({ runId: 'demo', manifest: '', startedAt: new Date().toISOString(), startMain: base, waves: [{ id: 'documentation', status: 'pending' }], tracks: {}, decisions: 0, costUsd: 0 }));
  await new Conductor(m, store, new Notifier(m.notify, store.dir, 'demo')).run();
  if (store.state.outcome !== 'done' || git('rev-parse', 'main') !== base) throw new Error(store.state.stopReason ?? 'Main changed');
  console.log(writeReport(m, store));
  console.log('Demo complete. No model sessions. Temporary repository will be removed.');
} finally { rmSync(root, { recursive: true, force: true }); }
