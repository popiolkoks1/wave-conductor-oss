import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGates } from '../src/gates.js';
import { normalizeManifest, loadManifest } from '../src/manifest.js';
import { initPlan, describePlan, prepareOutput } from '../src/onboarding.js';
import { protectedChanges } from '../src/protection.js';
import { Conductor } from '../src/conductor.js';
import { Store } from '../src/state.js';
import { Notifier } from '../src/notify.js';

test('failure comparison blocks new failures, missing reports and stale reports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'failure-test-'));
  try {
    const gate = { name: 'tests', failuresFile: 'failures.json', run: `echo '["old"]' > failures.json; exit 1` };
    assert.equal((await runGates([gate], root))[0].ok, false);
    assert.equal((await runGates([gate], root, { tests: ['old'] }))[0].ok, true);
    assert.equal((await runGates([{ ...gate, run: `echo '["old","new"]' > failures.json; exit 1` }], root, { tests: ['old'] }))[0].ok, false);
    assert.equal((await runGates([{ ...gate, run: 'true' }], root, { tests: ['old'] }))[0].ok, false);
    assert.equal((await runGates([{ ...gate, run: `echo '[]' > failures.json; exit 1` }], root, { tests: ['old'] }))[0].ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('result checkout integrates a real wave, preserves main, resumes and detects protected edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'result test-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    g('init', '-b', 'main'); g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid'); g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'test.txt'), 'original'); g('add', 'test.txt'); g('commit', '-m', 'initial');
    const base = g('rev-parse', 'main');
    g('switch', '-c', 'feature'); writeFileSync(join(repo, 'feature.txt'), 'feature'); g('add', 'feature.txt'); g('commit', '-m', 'feature'); g('switch', 'main');
    const file = join(root, 'plan.yaml'); await initPlan(file, repo);
    await assert.rejects(initPlan(file, repo), /EEXIST/);
    assert.match(describePlan(loadManifest(file)), /Preview only/);
    const raw = { name: 'result', repo, planDir: root, worktreeRoot: join(root, 'wt'), stateDir: join(root, 'state'), minFreeGb: 0, notify: { macos: false, heartbeatHours: 0 }, policy: { outputBranch: 'review/result', protectedPaths: ['test.txt'] }, waves: [{ id: 'one', gates: [{ name: 'test', run: 'test -f test.txt' }], tracks: [{ id: 'feature', branch: 'feature', done: true }] }] };
    const m = normalizeManifest(raw, root); await prepareOutput(m);
    const store = new Store(m.stateDir, 'demo', () => ({ runId: 'demo', manifest: file, startedAt: new Date().toISOString(), startMain: base, waves: [{ id: 'one', status: 'pending' }], tracks: {}, decisions: 0, costUsd: 0 }));
    await new Conductor(m, store, new Notifier(m.notify, store.dir, 'test')).run();
    assert.equal(store.state.outcome, 'done', store.state.stopReason ?? '');
    assert.equal(g('rev-parse', 'main'), base);
    assert.equal(g('branch', '--show-current'), 'main');
    assert.notEqual(g('rev-parse', 'review/result'), base);
    await prepareOutput(normalizeManifest(raw, root));
    writeFileSync(join(m.repo, 'test.txt'), 'weakened');
    execFileSync('git', ['add', 'test.txt'], { cwd: m.repo }); execFileSync('git', ['commit', '-m', 'changed test'], { cwd: m.repo, stdio: 'pipe' });
    assert.equal((await protectedChanges(m.repo, base, ['test.txt']))[0].ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
