import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest } from '../src/manifest.js';
import { REVIEWER, reviewerInstructions } from '../src/supervisor.js';

test('visual reviewer uses a neutral default and optional project instructions', () => {
  const m = normalizeManifest({ name: 'demo', repo: '.', planDir: '.', waves: [{ id: 'one', tracks: [{ id: 'task', prompt: 'Document API' }] }] }, '/tmp');
  assert.equal(reviewerInstructions(m), REVIEWER);
  m.review = { serve: 'serve', showcase: 'capture', instructions: 'Prioritize data labels in this dashboard.' };
  assert.ok(reviewerInstructions(m).endsWith(m.review.instructions!));
  assert.ok(reviewerInstructions(m).startsWith(REVIEWER));
});
