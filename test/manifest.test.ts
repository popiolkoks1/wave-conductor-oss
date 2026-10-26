import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest, branchOf } from '../src/manifest.js';

const ok = {
  name: 'x', repo: 'repo', planDir: 'plan',
  waves: [{ id: 'w1', tracks: [{ id: 'a', prompt: 'p' }, { id: 'b', promptFile: 'b.md', variants: [{ id: 'x', note: '' }, { id: 'y', note: '' }] }] }],
};

test('defaults and relative paths', () => {
  const m = normalizeManifest(ok, '/base');
  assert.equal(m.repo, '/base/repo');
  assert.equal(m.mainBranch, 'main');
  assert.equal(m.maxParallel, 4);
  assert.equal(m.policy.push, false);
  assert.equal(m.worktreeRoot, '/base/repo-conductor-wt');
});

test('track and variant branches', () => {
  const t = ok.waves[0].tracks[1] as any;
  assert.equal(branchOf(t), 'wave/b');
  assert.equal(branchOf(t, t.variants[0]), 'wave/b--x');
  assert.equal(branchOf({ id: 'z', branch: 'feat/z' } as any), 'feat/z');
});

test('validation errors', () => {
  assert.throws(() => normalizeManifest({ name: 'x' }, '/'), /repo/);
  assert.throws(() => normalizeManifest({ ...ok, waves: [{ id: 'w', tracks: [{ id: 'a' }] }] }, '/'), /promptFile or prompt/);
  assert.throws(() => normalizeManifest({ ...ok, waves: [{ id: 'w', tracks: [{ id: 'a', prompt: 'p' }, { id: 'a', prompt: 'q' }] }] }, '/'), /duplicate/);
  assert.throws(() => normalizeManifest({ ...ok, waves: [{ id: 'w', tracks: [{ id: 'a', prompt: 'p', variants: [{ id: 'x', note: '' }] }] }] }, '/'), /at least 2/);
  assert.throws(() => normalizeManifest({ ...ok, waves: [{ id: 'w', tracks: [{ id: 'a', prompt: 'p', gates: [{ name: 'g', run: 'true', runs: 2, mustPass: 3 }] }] }] }, '/'), /mustPass/);
});

import { baselineGatesOf } from '../src/manifest.js';

test('baseline measurement includes only regression gates', () => {
  const wave: any = {
    id: 'w',
    gates: [{ name: 'check', run: 'x' }, { name: 'wave-goal', run: 'y', baseline: false }, { name: 'readme', run: 'z' }],
    integrationGates: [{ name: 'verify', run: 'v' }],
    tracks: [{ id: 'a', prompt: 'p', gates: [{ name: 'readme', run: 'z' }, { name: 'goal', run: 'c' }] }],
  };
  assert.deepEqual(baselineGatesOf(wave).map((g) => g.name), ['check', 'verify']);
});

test('review instructions accept project requirements and reject invalid types', () => {
  const review = { serve: 'npm run dev', showcase: 'node screenshots.mjs', instructions: 'Check dashboard labels.' };
  assert.equal(normalizeManifest({ ...ok, review }, '/base').review?.instructions, review.instructions);
  assert.throws(() => normalizeManifest({ ...ok, review: { ...review, instructions: 42 } }, '/base'), /review.instructions/);
});
