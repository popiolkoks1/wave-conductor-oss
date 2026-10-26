import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { killProcessesIn, Mutex, cleanEnv, sh } from '../src/sh.js';

test('ubija proces zostawiony w katalogu (serwer dev), nie rusza sąsiada o podobnej nazwie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kill-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, 'wt'));
  mkdirSync(join(root, 'wt-2'));
  const victim = spawn('sleep', ['300'], { cwd: join(root, 'wt'), detached: true, stdio: 'ignore' });
  const neighbour = spawn('sleep', ['300'], { cwd: join(root, 'wt-2'), detached: true, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const killed = await killProcessesIn(join(root, 'wt'));
    assert.ok(killed.includes(victim.pid!), `ubite: ${killed}`);
    assert.ok(!killed.includes(neighbour.pid!));
  } finally {
    neighbour.kill('SIGKILL');
    victim.kill('SIGKILL');
  }
});

test('mutex: operacje po jednej, błąd nie blokuje kolejki', async () => {
  const mx = new Mutex();
  const order: string[] = [];
  const job = (id: string, ms: number, fail = false) =>
    mx.run(async () => {
      order.push(`+${id}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`-${id}`);
      if (fail) throw new Error(id);
    });
  await Promise.allSettled([job('a', 30, true), job('b', 5), job('c', 1)]);
  assert.deepEqual(order, ['+a', '-a', '+b', '-b', '+c', '-c']);
});

test('środowisko sesji bez zmiennych rodzica', () => {
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_SESSION_ID = 'x';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 't';
  const env = cleanEnv();
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 't');
});

test('missing working directory produces a failed result instead of crashing', async () => {
  const result = await sh('true', '/nonexistent-wave-conductor-directory');
  assert.notEqual(result.code, 0);
  assert.match(result.out, /Cannot start shell/);
});
