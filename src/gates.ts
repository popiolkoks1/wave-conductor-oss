import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Gate } from './manifest.js';
import { sh } from './sh.js';

export interface GateResult {
  name: string;
  ok: boolean;
  passes: number;
  runs: number;
  /** ogon wyjścia ostatniego czerwonego przebiegu — idzie do sesji naprawczej */
  tail: string;
  failures?: string[];
}

/**
 * Bramki liczy dyrygent, nie sesja: sesja może się pomylić co do własnego wyniku.
 * Szum (np. testy wizualne 22–43 porażki na tych samych plikach) tłumi `runs`/`mustPass`.
 */
export async function runGates(gates: Gate[], root: string, baseline: Record<string, string[]> = {}): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const g of gates) {
    const runs = g.runs ?? 1;
    const must = g.mustPass ?? runs;
    let passes = 0;
    let tail = '';
    let failures: string[] | undefined;
    for (let i = 0; i < runs; i++) {
      const file = g.failuresFile ? resolve(root, g.cwd ?? '.', g.failuresFile) : undefined;
      if (file) rmSync(file, { force: true });
      const r = await sh(g.run, resolve(root, g.cwd ?? '.'), g.timeoutSec ?? 1800);
      let accepted = r.code === 0;
      if (file) {
        try {
          const data = JSON.parse(readFileSync(file, 'utf8'));
          if (!Array.isArray(data) || data.some((id) => typeof id !== 'string')) throw new Error('expected string array');
          failures = [...new Set(data)] as string[];
          accepted = r.code === 0 ? failures.length === 0 : failures.length > 0 && baseline[g.name] !== undefined && failures.every((id) => baseline[g.name].includes(id));
        } catch (e) { accepted = false; tail = `Invalid failure report: ${e}`; }
      }
      if (accepted) passes++;
      else tail = (tail + '\n' + r.out).slice(-4000);
      if (passes >= must) break;
      if (runs - (i + 1) + passes < must) break;
    }
    results.push({ name: g.name, ok: passes >= must, passes, runs, tail, failures });
  }
  return results;
}

/**
 * Bramka czerwona już na czystym main przed falą nie może blokować torów — inaczej każdy tor
 * zostałby odłożony za cudzy błąd. W tej fali jest tylko informacyjna (i trafia do raportu).
 */
export const allGreen = (rs: GateResult[], baselineRed: string[] = []) => rs.every((r) => r.ok || baselineRed.includes(r.name));

export function describeGates(rs: GateResult[], baselineRed: string[] = []): string {
  if (rs.length === 0) return '(brak bramek)';
  return rs.map((r) => `${r.ok ? '✓' : baselineRed.includes(r.name) ? '◌' : '✗'} ${r.name} ${r.passes}/${r.runs}${!r.ok && baselineRed.includes(r.name) ? ' (czerwona już na main)' : ''}`).join(', ');
}

export function failureReport(rs: GateResult[], baselineRed: string[] = []): string {
  return rs
    .filter((r) => !r.ok && !baselineRed.includes(r.name))
    .map((r) => `### Bramka „${r.name}” czerwona (${r.passes}/${r.runs} zielonych)\n\`\`\`\n${r.tail}\n\`\`\``)
    .join('\n\n');
}
