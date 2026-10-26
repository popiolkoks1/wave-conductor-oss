import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { contextBundle, type Manifest } from './manifest.js';
import { runSession, type Question } from './session.js';
import type { Store } from './state.js';

const RULES = `Jesteś NADZORCĄ autonomicznego przebiegu fal pracy. Właściciel napisał plan i świadomie oddał WSZYSTKIE decyzje:
nie będzie odpowiadał aż do raportu końcowego. Odpowiadasz w jego imieniu.

Zasady wyboru (w tej kolejności):
1. Plan i zasady wspólne mają pierwszeństwo — jeśli rozstrzygają pytanie, trzymaj się ich dosłownie.
2. Wybieraj to, co ODWRACALNE i łatwe do poprawienia później promptem, zamiast tego, co zamyka drogę.
3. Nigdy nie wybieraj „poczekaj na właściciela”, „zapytaj później”, „wstrzymaj” — przebieg ma iść dalej.
4. Gdy plan każe „pokazać właścicielowi” (listę, makietę, STOP-KONCEPT) — akceptujesz sam: krytyczne i ważne
   poprawki TAK, kosmetyka do raportu; z dwóch wariantów wybierasz ten, który lepiej spełnia cel planu.
5. Operacje nieodwracalne (publikacja, wdrożenie produkcyjne, push --force, kasowanie cudzej pracy) — zawsze NIE; zapisz jako otwarte.
6. Push, scalanie do gałęzi głównej, kasowanie gałęzi i worktree robi DYRYGENT po zielonych bramkach — nigdy nie każ sesji
   tego robić, nawet jeśli plan tak mówi (sesji to i tak zostanie odrzucone). Powiedz jej, że to zadanie dyrygenta.
7. Opcja oznaczona „(Recommended)” wygrywa, jeśli nie łamie punktów 1–6.
Uzasadnienie pisz jednym zdaniem po polsku — trafi do DECYZJE.md, które właściciel przeczyta na końcu.`;

export const REVIEWER = `Jesteś NIEZALEŻNYM RECENZENTEM interfejsu projektu.
Oceniasz wyłącznie zrzuty ekranu i podane kryteria oraz cel projektu.
Nie czytasz raportów torów, podsumowań sesji ani samooceny autorów.
Sprawdź czytelność, dostępność widoczną na zrzutach, spójność, kompletność i regresje.
Nie narzucaj konkretnej estetyki ani wymagań branżowych, których nie ma w kryteriach.`;

export function reviewerInstructions(m: Manifest): string {
  return [REVIEWER, m.review?.instructions].filter(Boolean).join('\n\n');
}

export class Supervisor {
  private ctx: string;
  private criteria: string;
  constructor(private m: Manifest, private store: Store) {
    this.ctx = contextBundle(m);
    this.criteria = (m.review?.criteria ?? [])
      .map((f) => {
        const p = isAbsolute(f) ? f : join(m.planDir, f);
        return existsSync(p) ? `<<< ${f} >>>\n${readFileSync(p, 'utf8')}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  private recentDecisions(): string {
    const f = join(this.store.dir, 'DECYZJE.md');
    return existsSync(f) ? readFileSync(f, 'utf8').slice(-6000) : '(jeszcze żadnych)';
  }

  private base(extra: string) {
    return `${RULES}\n\n## Kontekst planu\n${this.ctx}\n\n## Dotychczasowe decyzje (ogon)\n${this.recentDecisions()}\n\n${extra}`;
  }

  private session(name: string, prompt: string, schema: Record<string, unknown>, tools = ['Read', 'Grep', 'Glob'], model = this.m.models.supervisor) {
    return runSession(
      {
        name: `nadzorca-${name}`,
        cwd: this.m.planDir,
        additionalDirectories: [this.m.repo, this.m.worktreeRoot, this.store.dir],
        prompt,
        model,
        tools,
        writeRoots: [],
        extraDeny: this.m.policy.denyBash ?? [],
        outputSchema: schema,
        settingSources: [],
        maxTurns: 30,
      },
      this.store,
    );
  }

  /** Odpowiedź na AskUserQuestion z sesji toru. Zwraca mapę pytanie → etykieta (lub własny tekst). */
  async answer(qs: Question[], from: string): Promise<Record<string, string>> {
    const schema = {
      type: 'object',
      properties: {
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { question: { type: 'string' }, answer: { type: 'string' }, reason: { type: 'string' } },
            required: ['question', 'answer', 'reason'],
          },
        },
      },
      required: ['answers'],
    };
    const prompt = this.base(
      `## Pytanie z sesji „${from}”\nOdpowiedz na każde pytanie. "answer" = dokładna etykieta jednej z opcji ` +
        `(przy multiSelect: etykiety po przecinku) albo — tylko gdy żadna opcja nie pasuje — krótki własny tekst.\n` +
        '```json\n' + JSON.stringify(qs, null, 2) + '\n```',
    );
    const out = await this.session(`pytanie-${from}`, prompt, schema);
    const res: Record<string, string> = {};
    const list: any[] = (out.structured as any)?.answers ?? [];
    for (const q of qs) {
      const hit = list.find((a) => a.question === q.question) ?? list[qs.indexOf(q)];
      const fallback = q.options.find((o) => /recommended/i.test(o.label))?.label ?? q.options[0]?.label ?? 'Kontynuuj';
      res[q.question] = hit?.answer ?? fallback;
      this.store.decision(
        `### ${new Date().toISOString().slice(0, 16)} · ${from}\n**Pytanie:** ${q.question}\n**Odpowiedź:** ${res[q.question]}\n**Dlaczego:** ${hit?.reason ?? 'nadzorca nie odpowiedział — wybrano opcję domyślną'}`,
      );
    }
    return res;
  }

  /**
   * Sesje często kończą się pytaniem tekstem („czy mam kontynuować?”) zamiast narzędziem.
   * Nadzorca czyta ostatnią wiadomość i decyduje: gotowe, odpowiedz i wznów, albo zablokowane.
   */
  async review(from: string, task: string, finalText: string): Promise<{ status: 'done' | 'continue' | 'blocked'; reply: string; summary: string }> {
    const schema = {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'continue', 'blocked'] },
        reply: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['status', 'reply', 'summary'],
    };
    const prompt = this.base(
      `## Ocena końca sesji „${from}”\nZadanie sesji (skrót):\n${task.slice(0, 5000)}\n\n` +
        `Ostatnia wiadomość sesji:\n"""\n${finalText.slice(-6000)}\n"""\n\n` +
        `Zwróć:\n- status "done" — sesja zrobiła swoje (nawet jeśli coś zapisała jako otwarte), reply puste;\n` +
        `- status "continue" — sesja pyta, czeka na zgodę, pokazuje listę do akceptacji albo zatrzymała się w połowie; ` +
        `reply = Twoja odpowiedź/decyzja, którą dostanie jako następną wiadomość (konkretna, rozstrzygająca, po polsku);\n` +
        `- status "blocked" — nie da się iść dalej bez rzeczy spoza repo (np. brak klucza API); reply = co zrobić zamiast.\n` +
        `summary = 1–3 zdania, co sesja zrobiła (do raportu).`,
    );
    const out = await this.session(`ocena-${from}`, prompt, schema, undefined, this.m.models.light ?? this.m.models.supervisor);
    const r = (out.structured as any) ?? { status: 'done', reply: '', summary: finalText.slice(0, 300) };
    if (r.status === 'continue') {
      this.store.decision(`### ${new Date().toISOString().slice(0, 16)} · ${from} (koniec sesji)\n**Sesja napisała:** ${finalText.slice(-600).replace(/\n+/g, ' ')}\n**Nadzorca odpowiedział:** ${r.reply}`);
    }
    return r;
  }

  /**
   * Wybór jednego z wariantów toru. Z `shots` (zrzuty zrobione przez dyrygenta) sędzia jest niezależnym recenzentem:
   * ocenia po obrazie, nie po samoocenie wariantu. Bez zrzutów — jak dotąd, z kodu i podsumowań.
   */
  async judge(trackId: string, criteria: string, variants: { id: string; branch: string; worktree: string; gates: string; summary: string; shots?: string[] }[]) {
    const schema = {
      type: 'object',
      properties: { winner: { type: 'string', enum: variants.map((v) => v.id) }, reason: { type: 'string' } },
      required: ['winner', 'reason'],
    };
    const visual = variants.every((v) => v.shots?.length);
    const prompt = visual
      ? `${reviewerInstructions(this.m)}\n\n## Kryteria projektu\n${this.criteria || '(brak pliku kryteriów)'}\n\n## Kontekst planu\n${this.ctx.slice(0, 40000)}\n\n` +
        `## Wybór wariantu toru „${trackId}”\nKryteria planu: ${criteria || 'lepiej spełnia cel planu'}\n\n` +
        variants.map((v) => `### Wariant ${v.id}\nbramki: ${v.gates}\nzrzuty (obejrzyj KAŻDY):\n${v.shots!.map((s) => `- ${s}`).join('\n')}`).join('\n\n') +
        `\n\nOceń każdy wariant 0–3 za każde kryterium planu na podstawie zrzutów, zsumuj, wybierz. W reason podaj punkty każdego wariantu i 2–3 konkretne obserwacje ze zrzutów. Niczego nie zmieniaj.`
      : this.base(
          `## Wybór wariantu toru „${trackId}”\nKryteria: ${criteria || 'lepiej spełnia cel planu; przy remisie prostszy i łatwiejszy do utrzymania.'}\n\n` +
            variants.map((v) => `### Wariant ${v.id}\ngałąź: ${v.branch}\nworktree: ${v.worktree}\nbramki: ${v.gates}\npodsumowanie sesji: ${v.summary}`).join('\n\n') +
            `\n\nMożesz czytać pliki w worktree i porównać diffy (git -C <worktree> diff <baza>...HEAD). Niczego nie zmieniaj.`,
        );
    const out = await this.session(`sedzia-${trackId}`, prompt, schema, visual ? ['Read', 'Glob'] : ['Read', 'Grep', 'Glob', 'Bash'], this.m.models.reviewer ?? this.m.models.judge ?? this.m.models.supervisor);
    const r = (out.structured as any) ?? { winner: variants[0].id, reason: 'sędzia nie odpowiedział — pierwszy wariant' };
    this.store.decision(`### ${new Date().toISOString().slice(0, 16)} · wybór wariantu ${trackId}${visual ? ' (recenzent po zrzutach)' : ''}\n**Wygrał:** ${r.winner}\n**Dlaczego:** ${r.reason}\n**Przegrane gałęzie zostają:** ${variants.filter((v) => v.id !== r.winner).map((v) => v.branch).join(', ')}`);
    return r as { winner: string; reason: string };
  }

  /** Recenzja fali po scaleniu: zrzuty „po” (i „przed” z poprzedniej fali) → gwiazdki i lista usterek. */
  async reviewWave(waveId: string, after: string[], before: string[]): Promise<{ stars: number; verdict: 'ok' | 'fix'; summary: string; issues: string[] }> {
    const schema = {
      type: 'object',
      properties: {
        stars: { type: 'integer', minimum: 0, maximum: 3 },
        verdict: { type: 'string', enum: ['ok', 'fix'] },
        summary: { type: 'string' },
        issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['stars', 'verdict', 'summary', 'issues'],
    };
    const prompt =
      `${reviewerInstructions(this.m)}\n\n## Kryteria projektu\n${this.criteria || '(brak pliku kryteriów)'}\n\n## Kontekst planu (cel projektu)\n${this.ctx.slice(0, 30000)}\n\n` +
      `## Recenzja po fali „${waveId}”\nZrzuty PO tej fali (obejrzyj każdy):\n${after.map((s) => `- ${s}`).join('\n')}\n\n` +
      (before.length ? `Zrzuty PRZED tą falą (do porównania):\n${before.map((s) => `- ${s}`).join('\n')}\n\n` : '') +
      `Zwróć: stars 0–3 (ocena interfejsu TERAZ, wg kryteriów projektu); verdict "fix", gdy widzisz regresję względem „przed”, ` +
      `zaślepkę, ucięty/nieczytelny element albo naruszenie podanych kryteriów w tym, co ta fala zmieniła — inaczej "ok"; issues = konkretne usterki ` +
      `(co, gdzie, na którym zrzucie), najważniejsze pierwsze; summary = 1–2 zdania po polsku.`;
    const out = await this.session(`recenzent-${waveId}`, prompt, schema, ['Read', 'Glob'], this.m.models.reviewer ?? this.m.models.judge ?? this.m.models.supervisor);
    const r = (out.structured as any) ?? { stars: 0, verdict: 'ok', summary: 'recenzent nie odpowiedział', issues: [] };
    this.store.decision(`### ${new Date().toISOString().slice(0, 16)} · recenzja fali ${waveId}\n**Ocena:** ${r.stars}★ (${r.verdict})\n**Podsumowanie:** ${r.summary}\n${r.issues.map((i: string) => `- ${i}`).join('\n')}`);
    return r;
  }
}
