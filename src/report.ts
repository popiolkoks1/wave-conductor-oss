import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from './manifest.js';
import type { Store } from './state.js';

const LABEL: Record<string, string> = {
  pending: '⏸ nie ruszony',
  running: '… w toku',
  green: '✓ zielony (niescalony)',
  merged: '✓ scalony',
  deferred: '✗ odłożony',
  'lost-variant': '↷ przegrany wariant',
};

const minsBetween = (a?: string, b?: string) => (a ? Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 60000) : undefined);

/** Raport, od którego właściciel zaczyna ręczne poprawki promptami. Pisany na bieżąco, nie tylko na końcu. */
export function writeReport(m: Manifest, store: Store): string {
  const s = store.state;
  const mins = minsBetween(s.startedAt, s.finishedAt) ?? 0;
  const L: string[] = [];
  const outcome = s.outcome === 'done' ? 'wszystkie fale przeszły' : s.outcome === 'stopped' ? 'ZATRZYMANY' : 'W TOKU';
  L.push(`# Raport przebiegu — ${m.name}`, '');
  L.push(`- przebieg: \`${s.runId}\`, ${s.startedAt.slice(0, 16).replace('T', ' ')} → ${s.finishedAt?.slice(0, 16).replace('T', ' ') ?? 'teraz'} (${mins} min)`);
  L.push(`- wynik: **${outcome}**${s.stopReason && s.outcome === 'stopped' ? ` — ${s.stopReason}` : ''}`);
  L.push(`- ${m.mainBranch}: \`${s.startMain.slice(0, 10)}\` → \`${s.waves.filter((w) => w.mergeCommit).at(-1)?.mergeCommit?.slice(0, 10) ?? 'bez zmian'}\``);
  L.push(`- decyzje nadzorcy: **${s.decisions}** (pełna lista: \`DECYZJE.md\`)`);
  L.push(`- szacowany koszt: $${s.costUsd.toFixed(2)}`, '');

  const tracks = Object.values(s.tracks);
  L.push(`- running: ${tracks.filter(t => t.status === 'running').length}; integrated: ${tracks.filter(t => t.status === 'merged').length}; deferred: ${tracks.filter(t => t.status === 'deferred').length}`);
  L.push(`- result branch: ${m.policy.outputBranch ?? m.mainBranch}`);
  L.push(`- next action: ${s.outcome === 'stopped' ? 'Read the stop reason, fix it, then resume with --resume-last.' : s.outcome === 'done' ? 'Review the result diff and any deferred tasks.' : 'Use conduct status to inspect progress.'}`, '');
  for (const w of s.waves) {
    const wm = minsBetween(w.startedAt, w.finishedAt);
    L.push(`## Fala ${w.id} — ${w.status}${w.pushed ? ' (wypchnięta)' : ''}${wm !== undefined ? ` · ${wm} min` : ''}`);
    if (w.note) L.push('', w.note.split('\n')[0]);
    if (w.review) {
      L.push('', `Recenzent: **${'★'.repeat(w.review.stars)}${'☆'.repeat(Math.max(0, 3 - w.review.stars))}** (${w.review.verdict}) — ${w.review.summary}`);
      if (w.review.issues.length) L.push(...w.review.issues.slice(0, 8).map((i) => `  - ${i}`));
      if (w.review.page) L.push('', `Pokaz przed / po: \`${w.review.page}\``);
    }
    if (w.baselineRed?.length) L.push('', `Bramki czerwone już na ${m.mainBranch} przed falą (w tej fali tylko informacyjne): **${w.baselineRed.join(', ')}**`);
    if (w.collided?.length) L.push('', `Awaryjne scalanie po jednym — odłożone, bo psuły integrację z resztą: **${w.collided.join(', ')}**`);
    L.push('', '| tor | status | min | commity | bramki / powód | koszt |', '|---|---|---|---|---|---|');
    for (const t of Object.values(s.tracks).filter((t) => t.wave === w.id)) {
      const tm = minsBetween(t.startedAt, t.finishedAt);
      L.push(`| ${t.id}${t.early ? ' ⚡' : ''} | ${LABEL[t.status]} | ${tm ?? '—'} | ${t.commits ?? '—'} | ${(t.reason ?? '').replace(/\n/g, ' ').replace(/\|/g, '/').slice(0, 220)} | $${t.costUsd.toFixed(2)} |`);
    }
    const sums = Object.values(s.tracks).filter((t) => t.wave === w.id && t.summary);
    if (sums.length) L.push('', ...sums.map((t) => `- **${t.id}:** ${t.summary}`));
    L.push('');
  }
  if (Object.values(s.tracks).some((t) => t.early)) L.push('⚡ = tor wystartował wcześniej, zanim skończyła się poprzednia fala (`needs`).', '');

  const left = Object.values(s.tracks).filter((t) => ['deferred', 'lost-variant', 'green'].includes(t.status));
  L.push('## Do obejrzenia ręcznie', '');
  if (left.length === 0) L.push(`Brak odłożonych torów. Gałąź wyniku: ${m.policy.outputBranch ?? m.mainBranch}.`);
  for (const t of left) L.push(`- \`${t.branch}\` (${LABEL[t.status]}) — ${(t.reason ?? '').split('\n')[0].slice(0, 200)}`);
  if (left.length) L.push('', 'Każda gałąź z tej listy zostaje w repo; worktree usunięto, jeśli był czysty.');
  L.push('', 'Logi sesji: `sessions/*.jsonl`, przebieg w czasie: `events.log`.');

  const text = L.join('\n') + '\n';
  writeFileSync(join(store.dir, 'REPORT.md'), text);
  return text;
}

/** Raport na żywo: przepisywany najwyżej co `everyMs` po zmianie stanu. */
export function liveReport(m: Manifest, store: Store, everyMs = 15_000): () => void {
  let last = 0;
  let pending: NodeJS.Timeout | undefined;
  const write = () => {
    pending = undefined;
    last = Date.now();
    writeReport(m, store);
  };
  return () => {
    if (pending) return;
    const wait = Math.max(0, last + everyMs - Date.now());
    if (wait === 0) write();
    else pending = setTimeout(write, wait).unref();
  };
}
