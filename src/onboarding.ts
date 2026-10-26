import { existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import YAML from 'yaml';
import type { Manifest } from './manifest.js';
import { git, q } from './sh.js';

export async function initPlan(file: string, repo: string) {
  const target = resolve(file);
  const root = resolve(repo);
  const branch = await git(root, 'branch --show-current');
  if (!branch) throw new Error('Select a Git branch first.');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, YAML.stringify({ name: 'my-change', repo: relative(dirname(target), root) || '.', planDir: '.', mainBranch: branch.trim(), maxParallel: 2, maxBudgetUsd: 5, maxRunBudgetUsd: 20, notify: { macos: false }, policy: { push: false, outputBranch: 'conductor/my-change', protectedPaths: [] }, waves: [{ id: 'implementation', gates: [{ name: 'tests', run: 'npm test' }], tracks: [{ id: 'change', required: true, prompt: 'Describe the change and acceptance criteria here. Add regression tests and commit your work.' }] }] }), { flag: 'wx' });
  return `Created ${target}. Edit the task, setup and test command, then run conduct plan ${target}.`;
}

export function describePlan(m: Manifest): string {
  const lines = [`${m.name}: ${m.waves.length} waves, up to ${m.maxParallel} concurrent sessions`, `Repository: ${m.repo}`, `Result: ${m.policy.outputBranch ?? m.mainBranch}; push: ${m.policy.push ? 'enabled' : 'disabled'}`, `Estimated budget limits: session $${m.maxBudgetUsd ?? 'unlimited'}, run $${m.maxRunBudgetUsd ?? 'unlimited'}`, `Protected paths: ${(m.policy.protectedPaths ?? []).join(', ') || 'none'}`];
  for (const w of m.waves) {
    lines.push(`\nWave ${w.id}`);
    for (const t of w.tracks) lines.push(`  ${t.id}${t.required ? ' [required]' : ''}${t.variants ? ` (${t.variants.length} variants)` : ''}: ${t.needs?.length ? `may start early after ${t.needs.join(', ')}` : 'starts after previous wave'}`);
    lines.push(`  Checks: ${(w.gates ?? []).map(g => `${g.name}: ${g.run}${g.failuresFile ? ' [failure comparison]' : ''}`).join('; ') || 'NONE'}`);
    lines.push(`  Integration: ${(w.integrationGates ?? w.gates ?? []).map(g => g.name).join(', ') || 'NONE'}`);
  }
  lines.push('\nPreview only: no agent sessions or test commands were executed.');
  return lines.join('\n');
}

/** A separate checkout lets every wave build on the result without advancing the source branch. */
export async function prepareOutput(m: Manifest): Promise<void> {
  if (!m.policy.outputBranch) return;
  const branch = m.policy.outputBranch;
  if ((await git(m.repo, `check-ref-format --branch ${q(branch)}`)).trim() !== branch) throw new Error('Invalid output branch');
  const path = resolve(m.worktreeRoot, '_result');
  const worktrees = await git(m.repo, 'worktree list --porcelain');
  const registered = existsSync(path) && worktrees.split('\n').filter(line => line.startsWith('worktree ')).some(line => {
    try { return realpathSync(line.slice(9)) === realpathSync(path); } catch { return false; }
  });
  if (!registered) {
    // Existing branches are deliberately rejected rather than silently reused.
    await git(m.repo, `worktree add -b ${q(branch)} ${q(path)} ${q(m.mainBranch)}`);
  } else {
    if ((await git(path, 'branch --show-current')).trim() !== branch) throw new Error('Result checkout belongs to another branch');
  }
  m.repo = path;
  m.mainBranch = branch;
}
