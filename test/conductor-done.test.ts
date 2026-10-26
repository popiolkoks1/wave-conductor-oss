import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeManifest } from '../src/manifest.js';
import { Store } from '../src/state.js';
import { Notifier } from '../src/notify.js';
import { Conductor } from '../src/conductor.js';

/** Fala z torami zrobionymi przed przebiegiem: zero sesji modelu — tylko scalanie, bramki, main, sprzątanie. */
test('tory done: scalanie gotowych gałęzi w kolejności, main przewinięty, cudze gałęzie zostają', async () => {
  const root = mkdtempSync(join(tmpdir(), 'done spacja-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const g = (c: string, cwd = repo) => execSync(`git ${c}`, { cwd, stdio: 'pipe' }).toString().trim();
  g('init -q -b main');
  g('config user.name t');
  g('config user.email t@example.invalid');
  g('config commit.gpgsign false');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add a.txt');
  g('commit -qm init');
  for (const b of ['art/scene-v2', 'feat/bigwin-v2']) {
    g(`switch -q -c ${b} main`);
    writeFileSync(join(repo, b.replace('/', '-') + '.txt'), b + '\n');
    g(`add ${b.replace('/', '-')}.txt`);
    g(`commit -qm ${b}`);
  }
  g('switch -q main');

  const m = normalizeManifest(
    {
      name: 'done', repo, planDir: root, worktreeRoot: join(root, 'wt'), stateDir: join(root, 'state'),
      notify: { macos: false, heartbeatHours: 0 },
      waves: [{
        id: 'wave-2',
        gates: [{ name: 'pliki', run: 'test -f a.txt' }],
        tracks: [
          { id: '2D', branch: 'art/scene-v2', done: true },
          { id: '2A', branch: 'feat/bigwin-v2', done: true },
          { id: '2X', branch: 'feat/nie-ma', done: true },
        ],
      }],
    },
    root,
  );
  const store = new Store(m.stateDir, 'r1', () => ({ runId: 'r1', manifest: '', startedAt: new Date().toISOString(), startMain: g('rev-parse main'), waves: [{ id: 'wave-2', status: 'pending' }], tracks: {}, decisions: 0, costUsd: 0 }));
  await new Conductor(m, store, new Notifier(m.notify, store.dir, 't')).run();

  assert.equal(store.state.outcome, 'done', store.state.stopReason ?? '');
  assert.ok(existsSync(join(repo, 'art-scene-v2.txt')) && existsSync(join(repo, 'feat-bigwin-v2.txt')), 'obie gałęzie w main');
  assert.equal(store.track('2X').status, 'deferred');
  assert.equal(store.track('2D').status, 'merged');
  const log = g('log --format=%s main');
  assert.ok(log.indexOf('art/scene-v2') > log.indexOf('feat/bigwin-v2'), 'kolejność scalania z manifestu');
  const branches = g("branch --format='%(refname:short)'");
  assert.match(branches, /art\/scene-v2/, 'gałęzie zrobione poza dyrygentem nie są kasowane');
  assert.doesNotMatch(branches, /integration\/wave-2/, 'gałąź integracji sprzątnięta');
});
