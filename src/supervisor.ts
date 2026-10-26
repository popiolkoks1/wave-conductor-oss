import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { contextBundle, type Manifest } from './manifest.js';
import { runSession, type Question } from './session.js';
import type { Store } from './state.js';

const RULES = `You supervise an autonomous coding run. The owner has written a plan and delegated all decisions until the final report. Answer on their behalf.
Apply these rules in order:
1. Follow the plan and shared rules exactly when they resolve the question.
2. Prefer reversible decisions that are easy to adjust later.
3. Do not choose to wait for the owner, ask later or pause; keep the run moving.
4. When the plan requests owner review of a list, mockup or concept, review it yourself. Accept critical and important fixes; record cosmetic issues in the report. Choose the variant that best meets the plan.
5. Reject irreversible actions such as publication, production deployment, force-pushing or deleting others' work; record them as open issues.
6. The conductor handles pushes, integration into the main branch and deletion of branches/worktrees after gates pass. Never ask a session to do these, even if the plan says so.
7. Prefer an option labeled (Recommended) when it does not violate rules 1–6.
Write your rationale in one English sentence for DECISIONS.md. Write all generated replies, summaries and reviews in English.`;

export const REVIEWER = `You are an INDEPENDENT REVIEWER of the project interface.
Evaluate only screenshots, supplied criteria and the project goal.
Do not read track reports, session summaries or authors' self-assessments.
Check readability, accessibility visible in screenshots, consistency, completeness and regressions.
Do not impose an aesthetic or industry-specific requirements absent from the criteria.
Write your review in English.`;

export function reviewerInstructions(m: Manifest): string {
  return [REVIEWER, m.review?.instructions].filter(Boolean).join('\n\n');
}

export class Supervisor {
  private ctx: string;
  private criteria: string;
  constructor(private m: Manifest, private store: Store) {
    this.ctx = contextBundle(m);
    this.criteria = (m.review?.criteria ?? []).map((f) => {
      const p = isAbsolute(f) ? f : join(m.planDir, f);
      return existsSync(p) ? `<<< ${f} >>>\n${readFileSync(p, 'utf8')}` : '';
    }).filter(Boolean).join('\n\n');
  }

  private recentDecisions(): string {
    const file = join(this.store.dir, 'DECISIONS.md');
    if (existsSync(file)) return readFileSync(file, 'utf8').slice(-6000);
    // Preserve decision context when resuming runs created before the English filename migration.
    const legacy = join(this.store.dir, 'DECYZJE.md');
    return existsSync(legacy) ? readFileSync(legacy, 'utf8').slice(-6000) : '(none yet)';
  }

  private base(extra: string) {
    return `${RULES}\n\n## Plan context\n${this.ctx}\n\n## Recent decisions\n${this.recentDecisions()}\n\n${extra}`;
  }

  private session(name: string, prompt: string, schema: Record<string, unknown>, tools = ['Read', 'Grep', 'Glob'], model = this.m.models.supervisor) {
    return runSession({ name: `supervisor-${name}`, cwd: this.m.planDir, additionalDirectories: [this.m.repo, this.m.worktreeRoot, this.store.dir], prompt, model, tools, writeRoots: [], extraDeny: this.m.policy.denyBash ?? [], outputSchema: schema, settingSources: [], maxTurns: 30 }, this.store);
  }

  /** Answer track questions with exact option labels, or a short custom answer. */
  async answer(qs: Question[], from: string): Promise<Record<string, string>> {
    const schema = {
      type: 'object', properties: { answers: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' }, reason: { type: 'string' } }, required: ['question', 'answer', 'reason'] } } }, required: ['answers'],
    };
    const prompt = this.base(`## Questions from session "${from}"\nAnswer every question. "answer" must be an exact option label (comma-separated labels for multiSelect). Use a short custom answer only when no option fits.\n\`\`\`json\n${JSON.stringify(qs, null, 2)}\n\`\`\``);
    const out = await this.session(`question-${from}`, prompt, schema);
    const res: Record<string, string> = {};
    const list: any[] = (out.structured as any)?.answers ?? [];
    for (const q of qs) {
      const hit = list.find((a) => a.question === q.question) ?? list[qs.indexOf(q)];
      const fallback = q.options.find((o) => /recommended/i.test(o.label))?.label ?? q.options[0]?.label ?? 'Continue';
      res[q.question] = hit?.answer ?? fallback;
      this.store.decision(`### ${new Date().toISOString().slice(0, 16)} · ${from}\n**Question:** ${q.question}\n**Answer:** ${res[q.question]}\n**Reason:** ${hit?.reason ?? 'No supervisor response; selected the default option.'}`);
    }
    return res;
  }

  /** A session can end with a plain-text question; decide whether to resume it. */
  async review(from: string, task: string, finalText: string): Promise<{ status: 'done' | 'continue' | 'blocked'; reply: string; summary: string }> {
    const schema = { type: 'object', properties: { status: { type: 'string', enum: ['done', 'continue', 'blocked'] }, reply: { type: 'string' }, summary: { type: 'string' } }, required: ['status', 'reply', 'summary'] };
    const prompt = this.base(`## Review the end of session "${from}"\nTask excerpt:\n${task.slice(0, 5000)}\n\nFinal message:\n"""\n${finalText.slice(-6000)}\n"""\n\nReturn:\n- status "done" when work is complete, even if open issues were recorded; leave reply empty.\n- status "continue" when the session asks a question, requests approval, presents a list for review or stops midway. Provide a concrete, decisive English reply to resume it.\n- status "blocked" when progress requires something outside the repository, such as a missing API key; reply with an alternative action.\nWrite summary in 1–3 English sentences describing completed work.`);
    const out = await this.session(`review-${from}`, prompt, schema, undefined, this.m.models.light ?? this.m.models.supervisor);
    const r = (out.structured as any) ?? { status: 'done', reply: '', summary: finalText.slice(0, 300) };
    if (r.status === 'continue') this.store.decision(`### ${new Date().toISOString().slice(0, 16)} · ${from} (session ended)\n**Session wrote:** ${finalText.slice(-600).replace(/\n+/g, ' ')}\n**Supervisor replied:** ${r.reply}`);
    return r;
  }

  /** Compare variants using independently captured screenshots when available. */
  async judge(trackId: string, criteria: string, variants: { id: string; branch: string; worktree: string; gates: string; summary: string; shots?: string[] }[]) {
    const schema = { type: 'object', properties: { winner: { type: 'string', enum: variants.map((v) => v.id) }, reason: { type: 'string' } }, required: ['winner', 'reason'] };
    const visual = variants.every((v) => v.shots?.length);
    const prompt = visual
      ? `${reviewerInstructions(this.m)}\n\n## Project criteria\n${this.criteria || '(no criteria file)'}\n\n## Plan context\n${this.ctx.slice(0, 40000)}\n\n## Choose a variant for track "${trackId}"\nPlan criteria: ${criteria || 'best meets the plan goal'}\n\n` +
        variants.map((v) => `### Variant ${v.id}\nGates: ${v.gates}\nScreenshots (inspect EVERY image):\n${v.shots!.map((s) => `- ${s}`).join('\n')}`).join('\n\n') +
        '\n\nScore each variant 0–3 per plan criterion using screenshots, total the scores and choose. In reason, include scores and 2–3 concrete observations. Do not modify anything.'
      : this.base(`## Choose a variant for track "${trackId}"\nCriteria: ${criteria || 'best meets the plan goal; prefer simpler maintenance when tied.'}\n\n` + variants.map((v) => `### Variant ${v.id}\nBranch: ${v.branch}\nWorktree: ${v.worktree}\nGates: ${v.gates}\nSession summary: ${v.summary}`).join('\n\n') + '\n\nYou may read worktree files and compare diffs (git -C <worktree> diff <base>...HEAD). Do not modify anything.');
    const out = await this.session(`judge-${trackId}`, prompt, schema, visual ? ['Read', 'Glob'] : ['Read', 'Grep', 'Glob', 'Bash'], this.m.models.reviewer ?? this.m.models.judge ?? this.m.models.supervisor);
    const r = (out.structured as any) ?? { winner: variants[0].id, reason: 'No judge response; selected the first variant.' };
    this.store.decision(`### ${new Date().toISOString().slice(0, 16)} · variant selection ${trackId}${visual ? ' (screenshot review)' : ''}\n**Winner:** ${r.winner}\n**Reason:** ${r.reason}\n**Retained alternative branches:** ${variants.filter((v) => v.id !== r.winner).map((v) => v.branch).join(', ')}`);
    return r as { winner: string; reason: string };
  }

  /** Review a wave using before/after screenshots and return actionable issues. */
  async reviewWave(waveId: string, after: string[], before: string[]): Promise<{ stars: number; verdict: 'ok' | 'fix'; summary: string; issues: string[] }> {
    const schema = { type: 'object', properties: { stars: { type: 'integer', minimum: 0, maximum: 3 }, verdict: { type: 'string', enum: ['ok', 'fix'] }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['stars', 'verdict', 'summary', 'issues'] };
    const prompt = `${reviewerInstructions(this.m)}\n\n## Project criteria\n${this.criteria || '(no criteria file)'}\n\n## Plan context (project goal)\n${this.ctx.slice(0, 30000)}\n\n## Review after wave "${waveId}"\nAFTER screenshots (inspect each):\n${after.map((s) => `- ${s}`).join('\n')}\n\n` +
      (before.length ? `BEFORE screenshots for comparison:\n${before.map((s) => `- ${s}`).join('\n')}\n\n` : '') +
      'Return stars 0–3 for the current interface against project criteria. Use verdict "fix" for regressions, placeholders, clipped/unreadable elements or criterion violations in areas changed by this wave; otherwise "ok". List specific issues (what, where and which screenshot), most important first. Write summary in 1–2 English sentences.';
    const out = await this.session(`reviewer-${waveId}`, prompt, schema, ['Read', 'Glob'], this.m.models.reviewer ?? this.m.models.judge ?? this.m.models.supervisor);
    const r = (out.structured as any) ?? { stars: 0, verdict: 'ok', summary: 'No reviewer response.', issues: [] };
    this.store.decision(`### ${new Date().toISOString().slice(0, 16)} · wave review ${waveId}\n**Rating:** ${r.stars}★ (${r.verdict})\n**Summary:** ${r.summary}\n${r.issues.map((i: string) => `- ${i}`).join('\n')}`);
    return r;
  }
}
