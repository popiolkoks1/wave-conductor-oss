import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGates, allGreen } from '../src/gates.js';

test('zielona i czerwona bramka', async () => {
  const r = await runGates([{ name: 'ok', run: 'true' }, { name: 'bad', run: 'echo boom; exit 3' }], tmpdir());
  assert.equal(r[0].ok, true);
  assert.equal(r[1].ok, false);
  assert.match(r[1].tail, /boom/);
  assert.equal(allGreen(r), false);
});

test('szum: 2 z 3 wystarczą, przerywa, gdy już przeszło', async () => {
  const d = mkdtempSync(join(tmpdir(), 'gate-'));
  // licznik w pliku: 1. przebieg czerwony, kolejne zielone
  writeFileSync(join(d, 'n'), '0');
  const run = 'n=$(cat n); echo $((n+1)) > n; [ "$n" -ge 1 ]';
  const [r] = await runGates([{ name: 'flaky', run, runs: 3, mustPass: 2 }], d);
  assert.equal(r.ok, true);
  assert.equal(r.passes, 2);
});

test('szum: przerywa, gdy nie da się już zdać', async () => {
  const [r] = await runGates([{ name: 'dead', run: 'false', runs: 5, mustPass: 3 }], tmpdir());
  assert.equal(r.ok, false);
  assert.equal(r.passes, 0);
});
