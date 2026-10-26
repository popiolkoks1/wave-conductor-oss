import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitMs } from '../src/session.js';

test('bez resetu: rosnące przerwy, łącznie dłużej niż okno 5 h', () => {
  assert.equal(waitMs(0, undefined), 60_000);
  assert.equal(waitMs(1, undefined), 5 * 60_000);
  let total = 0;
  for (let i = 0; i < 9; i++) total += waitMs(i, undefined);
  assert.ok(total > 5 * 3600_000, `${total / 3600_000} h`);
  assert.equal(waitMs(99, undefined), 60 * 60_000);
});

test('z resetem: czeka do resetu + 1 min (sekundy i ms)', () => {
  const now = 1_000_000_000_000;
  assert.equal(waitMs(0, now / 1000 + 3600, now), 3600_000 + 60_000);
  assert.equal(waitMs(0, now + 120_000, now), 180_000);
});

test('reset w przeszłości → zwykła przerwa; reset absurdalnie daleko → sufit 12 h', () => {
  const now = 1_000_000_000_000;
  assert.equal(waitMs(2, now / 1000 - 120, now), 15 * 60_000);
  assert.equal(waitMs(0, now / 1000 + 86400 * 3, now), 12 * 3600_000);
});
