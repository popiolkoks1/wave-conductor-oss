import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/state.js';
import { Supervisor, REVIEWER } from '../src/supervisor.js';
import { normalizeManifest } from '../src/manifest.js';

test('CLI help and empty status are in English without model calls', () => {
  const help = execFileSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts')], { encoding: 'utf8' });
  assert.match(help, /autonomous execution of a coding plan/);
  assert.match(help, /validate the manifest and prompt files/);
  const root = mkdtempSync(join(tmpdir(), 'english-cli-'));
  try {
    const manifest = join(root, 'plan.yaml');
    writeFileSync(manifest, 'name: english\nrepo: .\nplanDir: .\nwaves:\n  - id: one\n    tracks:\n      - id: task\n        prompt: Document the API\n');
    const status = execFileSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'status', manifest], { encoding: 'utf8' });
    assert.equal(status.trim(), 'No runs found.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('decision filename migration preserves legacy context and appends only to the English file', () => {
  const root = mkdtempSync(join(tmpdir(), 'english-decisions-'));
  try {
    const store = new Store(root, 'run', () => ({ runId: 'run', manifest: '', startedAt: new Date().toISOString(), startMain: 'abc', waves: [], tracks: {}, decisions: 0, costUsd: 0 }));
    const legacy = join(store.dir, 'DECYZJE.md');
    writeFileSync(legacy, '# Existing decision\n');
    const m = normalizeManifest({ name: 'english', repo: root, planDir: root, waves: [{ id: 'one', tracks: [{ id: 'task', prompt: 'Document API' }] }] }, root);
    const supervisor = new Supervisor(m, store);
    assert.match((supervisor as any).recentDecisions(), /Existing decision/);
    store.decision('## New decision');
    store.decision('## Another decision');
    const text = readFileSync(join(store.dir, 'DECISIONS.md'), 'utf8');
    assert.match(text, /Existing decision[\s\S]*New decision[\s\S]*Another decision/);
    assert.equal(text.match(/Existing decision/g)?.length, 1);
    assert.equal(readFileSync(legacy, 'utf8'), '# Existing decision\n');
    assert.equal((supervisor as any).recentDecisions(), text);
    assert.match(REVIEWER, /Write your review in English/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('new runs write only the English decision filename', () => {
  const root = mkdtempSync(join(tmpdir(), 'new-decisions-'));
  try {
    const store = new Store(root, 'run', () => ({ runId: 'run', manifest: '', startedAt: new Date().toISOString(), startMain: 'abc', waves: [], tracks: {}, decisions: 0, costUsd: 0 }));
    store.decision('## First decision');
    assert.equal(existsSync(join(store.dir, 'DECISIONS.md')), true);
    assert.equal(existsSync(join(store.dir, 'DECYZJE.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
