import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allGreen, describeGates, failureReport } from '../src/gates.js';

const rs = [
  { name: 'check', ok: true, passes: 1, runs: 1, tail: '' },
  { name: 'verify-sound', ok: false, passes: 0, runs: 1, tail: 'tempo' },
];

test('legacy baseline failures are visible but do not block', () => {
  assert.equal(allGreen(rs), false);
  assert.equal(allGreen(rs, ['verify-sound']), true);
  assert.match(describeGates(rs, ['verify-sound']), /◌ verify-sound 0\/1 \(already failing on main\)/);
  assert.equal(failureReport(rs, ['verify-sound']), '');
  assert.match(failureReport(rs), /verify-sound/);
});
