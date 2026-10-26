import { git, q } from './sh.js';
import type { GateResult } from './gates.js';

export async function protectedChanges(root: string, base: string, paths: string[]): Promise<GateResult[]> {
  if (!paths.length) return [];
  const changed = await git(root, `diff --name-only ${q(base)} HEAD -- ${paths.map(q).join(' ')}`);
  return [{ name: 'protected-paths', ok: !changed.trim(), passes: changed.trim() ? 0 : 1, runs: 1, tail: changed.trim() ? `Restore protected files before integration:\n${changed}` : '' }];
}
