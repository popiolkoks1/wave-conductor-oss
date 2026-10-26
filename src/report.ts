import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from './manifest.js';
import type { Store } from './state.js';

const LABEL: Record<string, string> = {
  pending: '⏸ pending',
  running: '… running',
  green: '✓ passing (not integrated)',
  merged: '✓ integrated',
  deferred: '✗ deferred',
  'lost-variant': '↷ unselected variant',
};

const minsBetween = (a?: string, b?: string) => (a ? Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 60000) : undefined);

/** Continuously update the report used by the owner to inspect results and plan follow-up work. */
export function writeReport(m: Manifest, store: Store): string {
  const s = store.state;
  const mins = minsBetween(s.startedAt, s.finishedAt) ?? 0;
  const L: string[] = [];
  const outcome = s.outcome === 'done' ? 'all waves completed' : s.outcome === 'stopped' ? 'STOPPED' : 'IN PROGRESS';
  L.push(`# Run report — ${m.name}`, '');
  L.push(`- run: \`${s.runId}\`, ${s.startedAt.slice(0, 16).replace('T', ' ')} → ${s.finishedAt?.slice(0, 16).replace('T', ' ') ?? 'now'} (${mins} min)`);
  L.push(`- result: **${outcome}**${s.stopReason && s.outcome === 'stopped' ? ` — ${s.stopReason}` : ''}`);
  L.push(`- ${m.mainBranch}: \`${s.startMain.slice(0, 10)}\` → \`${s.waves.filter((w) => w.mergeCommit).at(-1)?.mergeCommit?.slice(0, 10) ?? 'unchanged'}\``);
  L.push(`- supervisor decisions: **${s.decisions}** (full list: \`DECISIONS.md\`)`);
  L.push(`- estimated cost: $${s.costUsd.toFixed(2)}`, '');

  const tracks = Object.values(s.tracks);
  L.push(`- running: ${tracks.filter(t => t.status === 'running').length}; integrated: ${tracks.filter(t => t.status === 'merged').length}; deferred: ${tracks.filter(t => t.status === 'deferred').length}`);
  L.push(`- result branch: ${m.policy.outputBranch ?? m.mainBranch}`);
  L.push(`- next action: ${s.outcome === 'stopped' ? 'Read the stop reason, fix it, then resume with --resume-last.' : s.outcome === 'done' ? 'Review the result diff and any deferred tasks.' : 'Use conduct status to inspect progress.'}`, '');
  for (const w of s.waves) {
    const wm = minsBetween(w.startedAt, w.finishedAt);
    L.push(`## Wave ${w.id} — ${w.status}${w.pushed ? ' (pushed)' : ''}${wm !== undefined ? ` · ${wm} min` : ''}`);
    if (w.note) L.push('', w.note.split('\n')[0]);
    if (w.review) {
      L.push('', `Reviewer: **${'★'.repeat(w.review.stars)}${'☆'.repeat(Math.max(0, 3 - w.review.stars))}** (${w.review.verdict}) — ${w.review.summary}`);
      if (w.review.issues.length) L.push(...w.review.issues.slice(0, 8).map((i) => `  - ${i}`));
      if (w.review.page) L.push('', `Before / after showcase: \`${w.review.page}\``);
    }
    if (w.baselineRed?.length) L.push('', `Gates already failing on ${m.mainBranch} before the wave (informational for this wave): **${w.baselineRed.join(', ')}**`);
    if (w.collided?.length) L.push('', `Fallback integration one track at a time — deferred for breaking integration: **${w.collided.join(', ')}**`);
    L.push('', '| track | status | min | commits | gates / reason | cost |', '|---|---|---|---|---|---|');
    for (const t of Object.values(s.tracks).filter((t) => t.wave === w.id)) {
      const tm = minsBetween(t.startedAt, t.finishedAt);
      L.push(`| ${t.id}${t.early ? ' ⚡' : ''} | ${LABEL[t.status]} | ${tm ?? '—'} | ${t.commits ?? '—'} | ${(t.reason ?? '').replace(/\n/g, ' ').replace(/\|/g, '/').slice(0, 220)} | $${t.costUsd.toFixed(2)} |`);
    }
    const sums = Object.values(s.tracks).filter((t) => t.wave === w.id && t.summary);
    if (sums.length) L.push('', ...sums.map((t) => `- **${t.id}:** ${t.summary}`));
    L.push('');
  }
  if (Object.values(s.tracks).some((t) => t.early)) L.push('⚡ = track started early, before the previous wave completed (`needs`).', '');

  const left = Object.values(s.tracks).filter((t) => ['deferred', 'lost-variant', 'green'].includes(t.status));
  L.push('## Manual review', '');
  if (left.length === 0) L.push(`No deferred tracks. Result branch: ${m.policy.outputBranch ?? m.mainBranch}.`);
  for (const t of left) L.push(`- \`${t.branch}\` (${LABEL[t.status]}) — ${(t.reason ?? '').split('\n')[0].slice(0, 200)}`);
  if (left.length) L.push('', 'Listed branches remain in the repository; clean worktrees were removed.');
  L.push('', 'Session logs: `sessions/*.jsonl`, execution timeline: `events.log`.');

  const text = L.join('\n') + '\n';
  writeFileSync(join(store.dir, 'REPORT.md'), text);
  return text;
}

/** Rewrite the live report at most once every everyMs after state changes. */
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
