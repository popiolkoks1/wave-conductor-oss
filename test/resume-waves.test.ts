import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CONDUCT = resolve('bin/conduct');

/** Przebieg zakończony po fali A; właściciel dopisuje falę B do manifestu; wznowienie robi tylko B. */
test('nowa fala dopisana do manifestu jest wykonywana przy wznowieniu', () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-'));
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
  for (const b of ['wave/a1', 'wave/b1']) {
    g(`switch -q -c ${b} main`);
    writeFileSync(join(repo, b.replace('/', '-')), b);
    g(`add ${b.replace('/', '-')}`);
    g(`commit -qm ${b}`);
  }
  g('switch -q main');

  const manifest = (waves: string) => `name: r\nrepo: ${repo}\nplanDir: ${root}\nworktreeRoot: ${join(root, 'wt')}\nstateDir: ${join(root, 'state')}\nnotify: { macos: false, heartbeatHours: 0 }\nwaves:\n${waves}`;
  const A = `  - { id: A, tracks: [{ id: a1, branch: wave/a1, done: true }] }\n`;
  const B = `  - { id: B, tracks: [{ id: b1, branch: wave/b1, done: true }] }\n`;
  const mf = join(root, 'm.yaml');
  writeFileSync(mf, manifest(A));
  const r1 = spawnSync(CONDUCT, ['run', mf], { encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stderr + r1.stdout);
  const runId = readdirSync(join(root, 'state')).find((f) => /^\d{4}-/.test(f))!;

  writeFileSync(mf, manifest(A + B));
  const r2 = spawnSync(CONDUCT, ['run', mf, '--resume', runId], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  const st = JSON.parse(readFileSync(join(root, 'state', runId, 'state.json'), 'utf8'));
  assert.deepEqual(st.waves.map((w: any) => [w.id, w.status]), [['A', 'merged'], ['B', 'merged']]);
  assert.match(readFileSync(join(root, 'state', runId, 'events.log'), 'utf8'), /nowe fale B dopisane/);
  assert.ok(g('log --format=%s main').includes('wave/b1'));

  // usunięcie NIESCALONEJ fali z manifestu = odmowa wznowienia (nie gubimy pracy po cichu)
  const sf = join(root, 'state', runId, 'state.json');
  const st2 = JSON.parse(readFileSync(sf, 'utf8'));
  st2.waves[1].status = 'tracks';
  delete st2.outcome;
  writeFileSync(sf, JSON.stringify(st2));
  writeFileSync(mf, manifest(A));
  const r4 = spawnSync(CONDUCT, ['run', mf, '--resume', runId], { encoding: 'utf8' });
  assert.notEqual(r4.status, 0);
  assert.match(r4.stderr, /nie ma już niescalonych fal z przebiegu: B/);
});
