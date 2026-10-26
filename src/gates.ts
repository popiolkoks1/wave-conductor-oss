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
}

/**
 * Bramki liczy dyrygent, nie sesja: sesja może się pomylić co do własnego wyniku.
 * Szum (np. testy wizualne 22–43 porażki na tych samych plikach) tłumi `runs`/`mustPass`.
 */
export async function runGates(gates: Gate[], root: string): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const g of gates) {
    const runs = g.runs ?? 1;
    const must = g.mustPass ?? runs;
    let passes = 0;
    let tail = '';
    for (let i = 0; i < runs; i++) {
      const r = await sh(g.run, resolve(root, g.cwd ?? '.'), g.timeoutSec ?? 1800);
      if (r.code === 0) passes++;
      else tail = r.out.slice(-4000);
      if (passes >= must) break;
      if (runs - (i + 1) + passes < must) break;
    }
    results.push({ name: g.name, ok: passes >= must, passes, runs, tail });
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
