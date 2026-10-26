import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeManifest } from '../src/manifest.js';
import { Semaphore } from '../src/sh.js';
import { prestartBranch } from '../src/conductor.js';
import { Store } from '../src/state.js';
import { writeReport } from '../src/report.js';
import { writeShowcasePage } from '../src/showcase.js';

const raw = (waves: any[]) => ({ name: 'x', repo: '/r', planDir: '/p', waves });

test('needs only accepts tracks from earlier waves', () => {
  const ok = normalizeManifest(raw([{ id: 'A', tracks: [{ id: 'a', prompt: 'p' }] }, { id: 'B', tracks: [{ id: 'b', prompt: 'p', needs: ['a'] }] }]), '/');
  assert.deepEqual(ok.waves[1].tracks[0].needs, ['a']);
  assert.equal(ok.earlyPortOffset, 50);
  assert.throws(() => normalizeManifest(raw([{ id: 'A', tracks: [{ id: 'a', prompt: 'p', needs: ['b'] }, { id: 'b', prompt: 'p' }] }]), '/'), /needs „b” must reference a track from an earlier wave/);
  assert.throws(() => normalizeManifest(raw([{ id: 'A', tracks: [{ id: 'a', prompt: 'p', needs: ['missing'] }] }]), '/'), /needs „missing”/);
  assert.throws(() => normalizeManifest({ ...raw([{ id: 'A', tracks: [{ id: 'a', prompt: 'p' }] }]), review: { serve: 'x' } }, '/'), /review requires serve and showcase/);
});

test('semaphore limits concurrency and executes every task', async () => {
  const s = new Semaphore(2);
  let now = 0;
  let peak = 0;
  const done: number[] = [];
  await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      s.run(async () => {
        peak = Math.max(peak, ++now);
        await new Promise((r) => setTimeout(r, 20));
        now--;
        done.push(i);
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(done.length, 5);
});

function repoWith(root: string) {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const g = (c: string) => execSync(`git ${c}`, { cwd: repo, stdio: 'pipe' }).toString().trim();
  g('init -q -b main');
  g('config user.name t');
  g('config user.email t@example.invalid');
  g('config commit.gpgsign false');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add a.txt');
  g('commit -qm init');
  return { repo, g };
}

test('prestart combines main and dependencies; conflicts return undefined and clean up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prestart-'));
  const { repo, g } = repoWith(root);
  for (const [b, file, body] of [['t/x', 'x.txt', 'x'], ['t/y', 'y.txt', 'y'], ['t/c1', 'a.txt', 'c1'], ['t/c2', 'a.txt', 'c2']]) {
    g(`switch -q -c ${b} main`);
    writeFileSync(join(repo, file), body + '\n');
    g(`add ${file}`);
    g(`commit -qm ${b.replace('/', '-')}`);
  }
  g('switch -q main');
  const wt = join(root, 'wt');
  mkdirSync(wt);

  assert.equal(await prestartBranch(repo, wt, 'main', 'k0', []), g('rev-parse main'));
  const sha = await prestartBranch(repo, wt, 'main', 'k1', ['t/x', 't/y']);
  assert.ok(sha);
  const files = g(`ls-tree --name-only ${sha}`).split('\n');
  assert.deepEqual(files.sort(), ['a.txt', 'x.txt', 'y.txt']);
  assert.equal(g('rev-parse prestart/k1'), sha);
  assert.equal(existsSync(join(wt, '_prestart-k1')), false);

  assert.equal(await prestartBranch(repo, wt, 'main', 'k2', ['t/c1', 't/c2']), undefined);
  assert.equal(existsSync(join(wt, '_prestart-k2')), false);
  assert.equal(g('worktree list').split('\n').length, 1);
});

test('live report includes progress, duration, early starts and before/after review', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-'));
  const store = new Store(root, 'r1', () => ({
    runId: 'r1',
    manifest: 'm',
    startedAt: new Date(Date.now() - 5 * 60000).toISOString(),
    startMain: 'abcdef1234',
    waves: [{ id: 'A', status: 'merged', review: { stars: 2, verdict: 'ok', summary: 'consistent', issues: ['clipped counter'], page: 'x.html' } }, { id: 'B', status: 'tracks' }],
    tracks: { b1: { id: 'b1', wave: 'B', branch: 'w/b1', worktree: '/w', status: 'running', attempts: 0, costUsd: 1, early: true, startedAt: new Date(Date.now() - 3 * 60000).toISOString() } },
    decisions: 0,
    costUsd: 1,
  }));
  const m = normalizeManifest(raw([{ id: 'A', tracks: [{ id: 'a', prompt: 'p' }] }, { id: 'B', tracks: [{ id: 'b1', prompt: 'p', needs: ['a'] }] }]), '/');
  const text = writeReport(m, store);
  assert.match(text, /result: \*\*IN PROGRESS\*\*/);
  assert.match(text, /\(5 min\)/);
  assert.match(text, /b1 ⚡ \| … running \| 3 \|/);
  assert.match(text, /Reviewer: \*\*★★☆\*\* \(ok\)/);

  const shots = join(root, 'shots');
  mkdirSync(join(shots, 'after'), { recursive: true });
  mkdirSync(join(shots, 'before'), { recursive: true });
  for (const d of ['after', 'before']) writeFileSync(join(shots, d, 'play-desktop.png'), 'x');
  const page = writeShowcasePage(join(root, 'p.html'), 'T', { dir: join(shots, 'after'), pngs: [join(shots, 'after', 'play-desktop.png')], log: '' }, { dir: join(shots, 'before'), pngs: [join(shots, 'before', 'play-desktop.png')], log: '' }, { stars: 3, verdict: 'ok', summary: 's', issues: [] });
  const html = readFileSync(page, 'utf8');
  assert.match(html, /shots\/before\/play-desktop\.png/);
  assert.match(html, /shots\/after\/play-desktop\.png/);
  assert.match(html, /★★★/);
});

test('pre-completed dependent tracks integrate across waves in order', () => {
  const root = mkdtempSync(join(tmpdir(), 'needs-'));
  const { repo, g } = repoWith(root);
  for (const b of ['wave/a1', 'wave/b1']) {
    g(`switch -q -c ${b} main`);
    writeFileSync(join(repo, b.replace('/', '-')), b);
    g(`add ${b.replace('/', '-')}`);
    g(`commit -qm ${b}`);
  }
  g('switch -q main');
  const mf = join(root, 'm.yaml');
  writeFileSync(
    mf,
    `name: n\nrepo: ${repo.replace(/\\/g, '/')}\nplanDir: ${root.replace(/\\/g, '/')}\nworktreeRoot: ${join(root, 'wt').replace(/\\/g, '/')}\nstateDir: ${join(root, 'state').replace(/\\/g, '/')}\nnotify: { macos: false, heartbeatHours: 0 }\nwaves:\n` +
      `  - { id: A, tracks: [{ id: a1, branch: wave/a1, done: true }] }\n  - { id: B, tracks: [{ id: b1, branch: wave/b1, done: true, needs: [a1] }] }\n`,
  );
  const r = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'run', mf], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const runId = readdirSync(join(root, 'state')).find((f) => /^\d{4}-/.test(f))!;
  const st = JSON.parse(readFileSync(join(root, 'state', runId, 'state.json'), 'utf8'));
  assert.deepEqual(st.waves.map((w: any) => [w.id, w.status]), [['A', 'merged'], ['B', 'merged']]);
  assert.match(readFileSync(join(root, 'state', runId, 'REPORT.md'), 'utf8'), /all waves completed/);
  assert.ok(g('log --format=%s main').includes('wave/b1'));
});
