import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { baselineGatesOf, branchOf, mergePromptOf, trackPrompt, type Gate, type Manifest, type Track, type Variant, type Wave } from './manifest.js';
import { protectedChanges } from './protection.js';
import { allGreen, describeGates, failureReport, runGates, type GateResult } from './gates.js';
import type { Notifier } from './notify.js';
import { runSession, sleep, type SessionOutcome, type SessionSpec } from './session.js';
import { freeGb, git, gitOk, killPort, killProcessesIn, Mutex, q, removeDirHard, Semaphore, sh } from './sh.js';
import { takeShowcase, writeShowcasePage, type Shots } from './showcase.js';
import type { Store, TrackState, WaveState } from './state.js';
import { Supervisor } from './supervisor.js';

interface Unit {
  key: string;
  wave: Wave;
  track: Track;
  variant?: Variant;
  port: number;
}

export class StopRun extends Error {}

const WAIT_STEP_MIN = 10;

export class Conductor {
  private sup: Supervisor;
  /** operacje na wspólnym .git (worktree add/remove, gałęzie) po jednej naraz */
  private repoLock = new Mutex();
  private warned = new Set<string>();
  /** wspólny limit równoległych torów: bieżąca fala + tory startujące wcześniej (needs) */
  private slots: Semaphore;
  /** tory w toku w tym procesie — fala nie startuje ich drugi raz, tylko czeka na tę samą obietnicę */
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private m: Manifest,
    private store: Store,
    private notifier: Notifier,
  ) {
    this.sup = new Supervisor(m, store);
    this.slots = new Semaphore(m.maxParallel);
  }

  private log = (s: string) => this.store.log(s);

  /** Problem środowiska: jedno powiadomienie na rodzaj, nie co próbę. */
  private warnOnce(key: string, msg: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    void this.notifier.send('problem', msg);
  }

  async run(): Promise<void> {
    mkdirSync(this.m.worktreeRoot, { recursive: true });
    // Wznowienie po padnięciu procesu: sesje poprzedniego procesu mogły przeżyć jako sieroty i dalej pisać w worktree.
    for (const t of Object.values(this.store.state.tracks)) {
      if (t.status !== 'running' || !existsSync(t.worktree)) continue;
      const k = await killProcessesIn(t.worktree);
      if (k.length) this.log(`[${t.id}] wznowienie: ubito ${k.length} osierocony(ch) proces(ów) poprzedniego dyrygenta`);
    }
    for (const w of this.m.waves) if (this.store.wave(w.id).status === 'merging') await killProcessesIn(this.integrationDir(w));
    // Zaległe sprzątanie: fala scalona, a jej worktree zostały (przerwanie w trakcie sprzątania, zablokowane pliki na Windowsie).
    for (const w of this.m.waves) {
      if (this.store.wave(w.id).status !== 'merged') continue;
      const dirs = [this.integrationDir(w), ...Object.values(this.store.state.tracks).filter((t) => t.wave === w.id).map((t) => t.worktree)];
      if (dirs.some((d) => existsSync(d))) {
        this.log(`sprzątanie zaległe po fali ${w.id}`);
        await this.cleanup(w);
      }
    }
    const beat = setInterval(() => void this.notifier.heartbeat(() => this.statusLine()), 10 * 60_000);
    try {
      for (const wave of this.m.waves) {
        if (this.store.wave(wave.id).status === 'merged') continue;
        this.checkBudget();
        this.log(`══ FALA ${wave.id} ══`);
        const ws = this.store.wave(wave.id);
        ws.startedAt ??= new Date().toISOString();
        await this.runWave(wave);
        ws.finishedAt = new Date().toISOString();
        this.store.save();
        await this.notifier.send('wave', this.waveLine(wave));
      }
      this.store.state.outcome = 'done';
    } catch (e: any) {
      this.store.state.outcome = 'stopped';
      this.store.state.stopReason = e instanceof StopRun ? e.message : `błąd dyrygenta: ${e?.stack ?? e}`;
      this.log(`■ STOP: ${this.store.state.stopReason}`);
    } finally {
      clearInterval(beat);
      this.store.state.finishedAt = new Date().toISOString();
      this.store.save();
    }
  }

  statusLine(): string {
    const s = this.store.state;
    const cur = s.waves.find((w) => w.status !== 'merged');
    const ts = Object.values(s.tracks).filter((t) => t.wave === cur?.id);
    const n = (st: string) => ts.filter((t) => t.status === st).length;
    const done = s.waves.filter((w) => w.status === 'merged').length;
    return `trwa fala ${cur?.id ?? '—'} (${done}/${s.waves.length} gotowe): ${n('running')} w toku, ${n('green')} zielone, ${n('deferred')} odłożone · $${s.costUsd.toFixed(0)}`;
  }

  private waveLine(wave: Wave): string {
    const s = this.store.state;
    const ws = this.store.wave(wave.id);
    const ts = Object.values(s.tracks).filter((t) => t.wave === wave.id);
    const merged = ts.filter((t) => t.status === 'merged').length;
    const deferred = ts.filter((t) => t.status === 'deferred').map((t) => t.id);
    const idx = s.waves.findIndex((w) => w.id === wave.id) + 1;
    const rv = ws.review ? `, recenzent ${ws.review.stars}★${ws.review.page ? ` — pokaz: ${ws.review.page}` : ''}` : '';
    return `fala ${wave.id} (${idx}/${s.waves.length}): scalono ${merged}/${wave.tracks.length}${deferred.length ? `, odłożone: ${deferred.join(', ')}` : ''}${ws.baselineRed?.length ? `, bramki czerwone już na main: ${ws.baselineRed.join(', ')}` : ''}${rv}`;
  }

  private checkBudget() {
    const cap = this.m.maxRunBudgetUsd;
    if (cap && this.store.state.costUsd >= cap) throw new StopRun(`przekroczony budżet przebiegu $${cap} (wydano ~$${this.store.state.costUsd.toFixed(2)})`);
  }

  // ───────────────────────────── fala ─────────────────────────────

  /** `early` = tory startujące przed końcem poprzedniej fali: porty przesunięte, żeby nie gryzły się z bieżącą falą. */
  private units(wave: Wave, early = false): Unit[] {
    const out: Unit[] = [];
    let i = 0;
    for (const t of wave.tracks) {
      for (const v of t.variants ?? [undefined]) {
        // wczesne tory dwóch kolejnych fal mogą działać naraz — każda fala ma własną dziesiątkę portów
        const port = early ? this.m.basePort + this.m.earlyPortOffset + (this.m.waves.indexOf(wave) % 4) * 10 + i : (t.port ?? this.m.basePort + i);
        out.push({ key: v ? `${t.id}--${v.id}` : t.id, wave, track: t, variant: v, port });
        i++;
      }
    }
    return out;
  }

  private ensureState(u: Unit): TrackState {
    this.store.state.tracks[u.key] ??= {
      id: u.key,
      wave: u.wave.id,
      variant: u.variant?.id,
      branch: branchOf(u.track, u.variant),
      worktree: join(this.m.worktreeRoot, u.track.dir ? u.track.dir + (u.variant ? `--${u.variant.id}` : '') : u.key),
      status: 'pending',
      attempts: 0,
      costUsd: 0,
    };
    return this.store.state.tracks[u.key];
  }

  /** Tor w toku — jedna obietnica na tor w tym procesie; wspólny limit równoległości. */
  private launch(u: Unit, base: string): Promise<void> {
    const have = this.inflight.get(u.key);
    if (have) return have;
    const st = this.ensureState(u);
    if (st.port) u.port = st.port;
    const p = this.slots
      .run(() => this.runUnit(u, base))
      .catch((e) => {
        if (e instanceof StopRun) throw e;
        this.defer(this.store.track(u.key), `wyjątek dyrygenta: ${String(e?.message ?? e).slice(0, 500)}`);
      })
      .finally(async () => {
        this.inflight.delete(u.key);
        if (!u.track.done) {
          await killProcessesIn(this.store.track(u.key).worktree);
          await killPort(u.port);
        }
        void this.tryEarly(u.wave).catch((e) => this.log(`wczesny start: ${String(e?.message ?? e).slice(0, 300)}`));
      });
    this.inflight.set(u.key, p);
    return p;
  }

  // ───────────────────────────── wczesny start (needs) ─────────────────────────────

  /** Stan toru (z wariantami) z punktu widzenia zależności: gotowy = zielony/scalony i rozstrzygnięty. */
  private needState(id: string): { ready: boolean; branch?: string; merged: boolean } {
    const all = Object.values(this.store.state.tracks).filter((t) => t.id === id || t.id.startsWith(`${id}--`));
    if (all.length === 0) return { ready: false, merged: false };
    const merged = all.find((t) => t.status === 'merged');
    if (merged) return { ready: true, merged: true };
    if (all.some((t) => t.status === 'pending' || t.status === 'running')) return { ready: false, merged: false };
    const green = all.filter((t) => t.status === 'green');
    // warianty: rozstrzygnięte, gdy został jeden zielony (reszta przegrała albo odpadła)
    if (green.length === 1) return { ready: true, branch: green[0].branch, merged: false };
    return { ready: false, merged: false };
  }

  /** Startuje tory NASTĘPNEJ fali, których wszystkie `needs` są już gotowe — nie czekając na koniec bieżącej. */
  private async tryEarly(current: Wave) {
    const idx = this.m.waves.indexOf(current);
    const next = this.m.waves[idx + 1];
    if (!next || this.store.wave(next.id).status === 'merged') return;
    if (this.m.maxRunBudgetUsd && this.store.state.costUsd >= this.m.maxRunBudgetUsd) return;
    for (const u of this.units(next, true)) {
      const needs = u.track.needs;
      if (!needs?.length || u.track.done || this.inflight.has(u.key)) continue;
      const st = this.ensureState(u);
      if (['green', 'deferred', 'merged', 'lost-variant'].includes(st.status)) continue;
      const states = needs.map((n) => this.needState(n));
      if (!states.every((s) => s.ready)) continue;
      let base = st.baseSha;
      if (!base || st.status === 'pending') {
        const branches = states.filter((s) => !s.merged && s.branch).map((s) => s.branch!);
        base = await this.prestart(u.key, branches);
        if (!base) {
          this.warnOnce(`early-${u.key}`, `wczesny start ${u.key} niemożliwy (konflikt zależności) — poczeka na falę ${next.id}`);
          continue;
        }
      }
      if (this.inflight.has(u.key)) continue;
      st.early = true;
      st.port ??= u.port;
      st.baseSha = base;
      this.store.save();
      this.log(`[${u.key}] ⚡ wczesny start — zależności gotowe: ${needs.join(', ')}`);
      void this.launch(u, base);
    }
  }

  /** Gałąź `prestart/<tor>` = main + zielone (jeszcze niescalone) gałęzie zależności. Zwraca SHA albo undefined przy konflikcie. */
  private prestart(key: string, branches: string[]): Promise<string | undefined> {
    return this.repoLock.run(() => prestartBranch(this.m.repo, this.m.worktreeRoot, this.m.mainBranch, key, branches, (l) => this.log(l)));
  }

  private async runWave(wave: Wave) {
    const ws = this.store.wave(wave.id);
    const base = await git(this.m.repo, `rev-parse ${this.m.mainBranch}`);
    const units = this.units(wave);
    for (const u of units) this.ensureState(u);

    // Bazowy pomiar bramek na czystym main, zanim ruszy jakikolwiek tor.
    const iwt = this.integrationDir(wave);
    if (ws.status === 'pending') {
      await this.ensureIntegration(wave);
      const gates = baselineGatesOf(wave);
      if (gates.length) {
        this.log(`[${wave.id}] pomiar bazowy bramek na ${this.m.mainBranch}`);
        const base0 = await runGates(gates, iwt);
        ws.baselineRed = base0.filter((r) => !r.ok && !gates.find((g) => g.name === r.name)?.failuresFile).map((r) => r.name);
        ws.baselineFailures = Object.fromEntries(base0.filter((r) => r.failures).map((r) => [r.name, r.failures!]));
        if (ws.baselineRed.length) this.log(`[${wave.id}] czerwone już na ${this.m.mainBranch} (w tej fali tylko informacyjne): ${ws.baselineRed.join(', ')}`);
      }
      await killProcessesIn(iwt);
    }
    ws.status = 'tracks';
    this.store.save();

    // Tory następnej fali, których zależności są gotowe już teraz (np. po wznowieniu), startują od razu.
    await this.tryEarly(wave).catch((e) => this.log(`wczesny start: ${String(e?.message ?? e).slice(0, 300)}`));
    // Kolejność startu = kolejność w manifeście; tory tej fali mają pierwszeństwo przed wczesnymi (kolejka semafora).
    await Promise.all(units.map((u) => this.launch(u, u.track.base ?? this.store.track(u.key).baseSha ?? base)));

    // Warianty: sędzia wybiera jeden z zielonych, reszta zostaje na gałęziach.
    for (const t of wave.tracks.filter((t) => t.variants)) {
      const green = t.variants!.map((v) => this.store.track(`${t.id}--${v.id}`)).filter((s) => s.status === 'green');
      if (green.length >= 2) {
        const visual = this.m.review && this.m.review.judge !== false;
        const shots = new Map<string, string[]>();
        if (visual) {
          for (const s of green) {
            const sh0 = await takeShowcase(this.m.review!, s.worktree, this.reviewPort(), join(this.store.dir, 'showcase', s.id));
            this.log(`[${s.id}] pokaz dla sędziego: ${sh0.pngs.length} zrzutów${sh0.pngs.length ? '' : ` — ${sh0.log.slice(-200)}`}`);
            shots.set(s.id, sh0.pngs);
          }
        }
        const r = await this.sup.judge(
          t.id,
          t.judgeCriteria ?? '',
          green.map((s) => ({ id: s.variant!, branch: s.branch, worktree: s.worktree, gates: s.reason ?? '', summary: s.summary ?? '', shots: shots.get(s.id) })),
        );
        for (const s of green) if (s.variant !== r.winner) { s.status = 'lost-variant'; s.reason = `przegrał z ${r.winner}: ${r.reason}`; }
        this.log(`[${t.id}] wygrał wariant ${r.winner}`);
      }
      this.store.save();
    }
    await this.tryEarly(wave).catch((e) => this.log(`wczesny start: ${String(e?.message ?? e).slice(0, 300)}`));

    // Tor wystartował wcześniej na zależnościach, które ostatecznie nie weszły do main — nie wolno go scalić (wniósłby je tylnymi drzwiami).
    for (const u of units) {
      const st = this.store.track(u.key);
      if (!st.early || st.status !== 'green') continue;
      const missing = (u.track.needs ?? []).filter((n) => !this.needState(n).merged);
      if (missing.length) this.defer(st, `wystartował wcześniej na ${missing.join(', ')}, a te tory nie weszły do ${this.m.mainBranch} — gałąź zostaje do ręcznego przejrzenia`);
    }

    for (const t of wave.tracks.filter((t) => t.required)) {
      const mine = units.filter((u) => u.track === t).map((u) => this.store.track(u.key));
      if (!mine.some((x) => x.status === 'green' || x.status === 'merged'))
        throw new StopRun(`tor wymagany ${t.id} nie przeszedł: ${mine.map((x) => x.reason).join(' | ').slice(0, 300)}`);
    }

    const ready = units.map((u) => this.store.track(u.key)).filter((s) => s.status === 'green');
    if (ready.length === 0) {
      ws.status = 'merged';
      ws.note = 'żaden tor nie był zielony — nic nie scalono';
      this.store.save();
      this.log(`[${wave.id}] ${ws.note}`);
    } else {
      await this.mergeWave(wave, ready);
    }
    await this.cleanup(wave);
  }

  // ───────────────────────────── tor ─────────────────────────────

  private preamble(u: Unit, st: TrackState, base: string, gates: Gate[], baselineRed: string[]): string {
    const ctx = this.m.context.map((c) => `- ${join(this.m.planDir, c)}`).join('\n');
    return `# Tryb autonomiczny (dyrygent fal)
Pracujesz BEZ człowieka. Właściciel oddał decyzje; odpowiada za niego nadzorca.
- Tor: **${u.track.id}**${u.variant ? ` — wariant **${u.variant.id}**: ${u.variant.note}` : ''} (fala ${u.wave.id}).
- Twój worktree: \`${st.worktree}\`, gałąź \`${st.branch}\`, baza \`${base.slice(0, 10)}\`. Inne tory pracują równolegle w innych katalogach — nie dotykaj ich.${this.m.sessionCwd ? `\n- Sesja startuje w \`${this.m.sessionCwd}\` (hooki projektu), ale CAŁĄ pracę robisz w worktree: \`cd "${st.worktree}"\` (cytuj ścieżkę).` : ''}
- Jeśli prompt planu każe pracować w innym katalogu, na innej gałęzi albo porcie (np. w checkoutcie z \`${this.m.mainBranch}\`) — pracujesz w TYM worktree, na TEJ gałęzi i TYM porcie. \`git push\` gałęzi robi dyrygent po zielonych bramkach.${[...(this.m.policy.denyPaths ?? []), ...(u.track.denyPaths ?? [])].length ? `\n- Zapis do tych ścieżek jest zablokowany: ${[...(this.m.policy.denyPaths ?? []), ...(u.track.denyPaths ?? [])].join(', ')}.` : ''}
- Serwer dev, jeśli go potrzebujesz: port **${u.port}**, uruchamiany W TLE (nigdy na pierwszym planie — sesja dłuższa niż ${this.m.sessionTimeoutMin} min jest przerywana). Dyrygent ubije go po Twoim torze.
- Najpierw przeczytaj kontekst planu:\n${ctx || '- (brak)'}
- Pytanie albo decyzja (także „pokaż właścicielowi”, STOP-KONCEPT, wybór A/B) → narzędzie **AskUserQuestion**; odpowie nadzorca, a Ty działasz dalej według odpowiedzi. Nie zadawaj pytań w tekście i nie kończ sesji, żeby czekać.
- Commituj na swojej gałęzi małymi commitami, stagując ścieżki JAWNIE. NIE pushuj, NIE scalaj do gałęzi głównej, NIE przełączaj gałęzi, NIE kasuj gałęzi ani worktree — to robi dyrygent. Zakazane polecenia zostaną odrzucone.
- Bramki, które dyrygent odpali po Tobie w tym worktree: ${gates.map((g) => `\`${g.run}\``).join(', ') || '(brak)'}. Uruchom je sam przed końcem.${baselineRed.length ? `\n- Te bramki były czerwone już na czystym main, więc Ciebie nie blokują (nie naprawiaj ich, chyba że to Twoje zadanie): ${baselineRed.join(', ')}.` : ''}
- Operacje nieodwracalne (publikacja, wysyłka na zewnątrz) pomijasz i zapisujesz jako otwarte.
- Szybkość: kilka niezależnych, długich zadań (symulacje wariantów, serie generacji, pomiary w kilku widokach) uruchamiaj RÓWNOLEGLE — w tle albo podagentami (narzędzie Agent) — zamiast jedno po drugim.
- Na końcu: krótkie podsumowanie — co zrobione, co zostało otwarte. Worktree ma być czysty (wszystko zacommitowane).

---

`;
  }

  private baseSpec(name: string, worktree: string, costKey: string | null, model?: string): Omit<SessionSpec, 'prompt'> {
    return {
      name,
      costKey,
      cwd: this.m.sessionCwd ?? worktree,
      worktree,
      denyPaths: this.m.policy.denyPaths ?? [],
      model,
      writeRoots: [worktree, ...(this.m.policy.writeRoots ?? [])],
      extraDeny: this.m.policy.denyBash ?? [],
      answer: (qs, from) => this.sup.answer(qs, from),
      settingSources: this.m.settingSources,
      maxTurns: this.m.maxTurns,
      maxBudgetUsd: this.m.maxBudgetUsd,
      timeoutMin: this.m.sessionTimeoutMin,
      onWait: (msg) => this.warnOnce(`limit-${new Date().toISOString().slice(0, 13)}`, msg),
    };
  }

  private async runUnit(u: Unit, base: string) {
    const st = this.store.track(u.key);
    if (['green', 'deferred', 'merged', 'lost-variant'].includes(st.status)) return;
    if (this.m.maxRunBudgetUsd && this.store.state.costUsd >= this.m.maxRunBudgetUsd) return this.defer(st, 'budżet przebiegu wyczerpany przed startem toru');
    if (u.track.done) return this.adoptDone(st);
    const ws = this.store.wave(u.wave.id);
    const baselineRed = ws.baselineRed ?? [];
    const gates = [...(u.track.gates ?? []), ...(u.wave.gates ?? [])];

    st.port ??= u.port;
    st.startedAt ??= new Date().toISOString();
    try {
      const fresh = !(await this.isWorktreeOn(st.worktree, st.branch));
      await this.ensureWorktree(st, base);
      if (fresh || !st.baseSha) st.baseSha = base;
    } catch (e: any) {
      if (e instanceof StopRun) throw e;
      return this.defer(st, `nie udało się założyć worktree: ${String(e.message).slice(0, 300)}`);
    }

    const task = trackPrompt(this.m, u.track);
    const base0 = this.baseSpec(u.key, st.worktree, u.key, u.track.model ?? this.m.models.track);
    const common = {
      ...base0,
      denyPaths: [...(base0.denyPaths ?? []), ...(u.track.denyPaths ?? [])],
      onSessionId: (id: string) => {
        st.sessionId = id;
        this.store.save();
      },
    };
    let out: SessionOutcome;
    const talk = async (prompt: string, fresh = false) => {
      out = await runSession({ ...common, prompt, resume: fresh ? undefined : st.sessionId }, this.store);
      st.sessionId = out.sessionId ?? st.sessionId;
      this.store.save();
    };

    const resumed = st.status === 'running' && !!st.sessionId;
    st.status = 'running';
    this.store.save();
    this.log(`[${u.key}] ${resumed ? 'wznowienie' : 'start'} (${st.branch})`);
    if (resumed) await talk('Dyrygent został wznowiony po przerwie. Kontynuuj zadanie od miejsca, w którym przerwałeś.');
    else await talk(this.preamble(u, st, base, gates, baselineRed) + task, true);

    // Pętla „czy sesja naprawdę skończyła?” — odpowiada nadzorca, nie człowiek.
    const settle = async () => {
      for (let i = 0; i < this.m.maxFollowUps; i++) {
        const r = await this.sup.review(u.key, task, out.text);
        st.summary = r.summary;
        if (r.status === 'done') return;
        if (r.status === 'blocked') this.log(`[${u.key}] zablokowana: ${r.reply.slice(0, 200)}`);
        this.log(`[${u.key}] nadzorca odpowiada i wznawia sesję`);
        await talk(r.reply);
      }
    };
    await settle();

    for (let attempt = 0; ; attempt++) {
      st.attempts = attempt;
      await killProcessesIn(st.worktree);
      const dirty = (await sh('git status --porcelain', st.worktree)).out.trim();
      if (dirty) {
        if (attempt >= this.m.maxFixAttempts) return this.defer(st, `worktree nadal brudny po ${attempt} próbach:\n${dirty.slice(0, 500)}`);
        this.log(`[${u.key}] niezacommitowane zmiany — sesja ma je zacommitować`);
        await talk(`Dyrygent: w worktree zostały niezacommitowane zmiany:\n${dirty.slice(0, 2000)}\nZacommituj to, co jest częścią pracy (ścieżki jawnie), a śmieci dopisz do .gitignore albo usuń. Worktree ma być czysty.`);
        continue;
      }
      const results = await runGates(gates, st.worktree, ws.baselineFailures);
      await killProcessesIn(st.worktree);
      results.push(...await protectedChanges(st.worktree, st.baseSha ?? base, this.m.policy.protectedPaths ?? []));
      st.reason = describeGates(results, baselineRed);
      this.store.save();
      if (allGreen(results, baselineRed)) break;
      if (attempt >= this.m.maxFixAttempts) return this.defer(st, `bramki czerwone po ${attempt} poprawkach: ${st.reason}`);
      this.log(`[${u.key}] bramki: ${st.reason} — poprawka ${attempt + 1}/${this.m.maxFixAttempts}`);
      await talk(`Dyrygent uruchomił bramki w Twoim worktree i część jest czerwona. Napraw przyczynę (nie osłabiaj bramki), zacommituj i uruchom je ponownie.\n\n${failureReport(results, baselineRed)}`);
      await settle();
    }

    st.commits = Number(await git(st.worktree, `rev-list --count ${st.baseSha ?? base}..HEAD`));
    st.status = 'green';
    st.finishedAt = new Date().toISOString();
    this.store.save();
    this.log(`[${u.key}] ZIELONY — ${st.commits} commitów, ${st.reason}`);
    if (this.m.policy.push) {
      // kopia zapasowa gałęzi toru na origin (plan tego wymaga); nigdy --force
      const p = await sh(`git push -u origin ${q(st.branch)}`, st.worktree, 600);
      this.log(`[${u.key}] push ${st.branch}: ${p.code === 0 ? 'ok' : 'NIEUDANY — ' + p.out.trim().slice(-200)}`);
    }
  }

  /** Tor zrobiony poza dyrygentem: gałąź musi istnieć (lokalnie albo na origin); idzie prosto do scalania. */
  private async adoptDone(st: TrackState) {
    const has = (ref: string) => gitOk(this.m.repo, `rev-parse --verify -q ${q(ref)}`);
    await this.repoLock.run(async () => {
      if (!(await has(`refs/heads/${st.branch}`))) {
        if (await has(`refs/remotes/origin/${st.branch}`)) await git(this.m.repo, `branch ${q(st.branch)} ${q(`origin/${st.branch}`)}`);
      }
    });
    if (!(await has(`refs/heads/${st.branch}`))) return this.defer(st, `tor oznaczony done, ale gałęzi ${st.branch} nie ma ani lokalnie, ani na origin`);
    st.ownBranch = false;
    st.commits = Number(await git(this.m.repo, `rev-list --count ${q(this.m.mainBranch)}..${q(st.branch)}`));
    st.status = 'green';
    st.reason = 'zrobiony przed przebiegiem (done)';
    this.store.save();
    this.log(`[${st.id}] gotowy przed przebiegiem — ${st.branch}, ${st.commits} commitów`);
  }

  private reviewPort = () => this.m.review?.port ?? this.m.mergePort + 5;

  private defer(st: TrackState, reason: string) {
    st.status = 'deferred';
    st.reason = reason;
    st.finishedAt ??= new Date().toISOString();
    this.store.save();
    this.log(`[${st.id}] ODŁOŻONY: ${reason.slice(0, 300)}`);
  }

  /** Czeka na miejsce na dysku (inne tory mogą je zwolnić), potem się poddaje. */
  private async waitForDisk(what: string) {
    for (let waited = 0; ; waited += WAIT_STEP_MIN) {
      const gb = await freeGb(this.m.worktreeRoot);
      if (gb >= this.m.minFreeGb) return;
      if (waited >= this.m.mainBusyWaitMin) throw new StopRun(`za mało miejsca na dysku (${gb.toFixed(1)} GB < ${this.m.minFreeGb} GB) — ${what}`);
      this.warnOnce('disk', `mało miejsca na dysku: ${gb.toFixed(1)} GB — czekam, zanim założę kolejny worktree`);
      this.log(`dysk: ${gb.toFixed(1)} GB wolnego < ${this.m.minFreeGb} GB — czekam ${WAIT_STEP_MIN} min (${what})`);
      await sleep(WAIT_STEP_MIN * 60_000);
    }
  }

  /** Czy `dir` jest zarejestrowanym worktree na gałęzi `branch`? */
  private async isWorktreeOn(dir: string, branch: string) {
    if (!existsSync(join(dir, '.git'))) return false;
    const r = await sh('git rev-parse --abbrev-ref HEAD', dir);
    return r.code === 0 && r.out.trim() === branch;
  }

  /**
   * Zakłada worktree toru. Odporne na:
   * - katalog po poprzednim przebiegu, który nie jest już worktree (odkładany na bok, nie kasowany),
   * - gałąź o tej nazwie z dawnej pracy: scalona → usuwana i zakładana od nowa; nie scalona → nowa nazwa -r2, -r3…
   */
  private async ensureWorktree(st: TrackState, base: string) {
    if (await this.isWorktreeOn(st.worktree, st.branch)) {
      if (!st.setupDone) await this.runSetup(st.worktree, () => (st.setupDone = true));
      return;
    }
    await this.waitForDisk(`worktree ${st.id}`);
    await this.repoLock.run(async () => {
      if (existsSync(st.worktree)) {
        const aside = `${st.worktree}.stale-${Date.now()}`;
        renameSync(st.worktree, aside);
        this.log(`[${st.id}] katalog worktree nie pasował — odłożony na bok jako ${aside}`);
        await sh('git worktree prune', this.m.repo);
      }
      const has = (b: string) => gitOk(this.m.repo, `rev-parse --verify -q ${q(`refs/heads/${b}`)}`);
      if (!st.ownBranch && (await has(st.branch))) {
        if (await gitOk(this.m.repo, `merge-base --is-ancestor ${q(st.branch)} ${q(this.m.mainBranch)}`)) {
          const r = await sh(`git branch -d ${q(st.branch)}`, this.m.repo);
          this.log(`[${st.id}] stara gałąź ${st.branch} była już w ${this.m.mainBranch} — ${r.code === 0 ? 'usunięta' : 'zostaje (zajęta przez inny worktree)'}`);
        }
        let n = 2;
        const orig = st.branch;
        while (await has(st.branch)) st.branch = `${orig}-r${n++}`;
        if (st.branch !== orig) this.log(`[${st.id}] gałąź ${orig} zajęta cudzą pracą — tor idzie na ${st.branch}`);
      }
      if (st.ownBranch && (await has(st.branch))) await git(this.m.repo, `worktree add ${q(st.worktree)} ${q(st.branch)}`);
      else await git(this.m.repo, `worktree add -b ${q(st.branch)} ${q(st.worktree)} ${base}`);
      st.ownBranch = true;
      st.setupDone = false;
      this.store.save();
    });
    await this.runSetup(st.worktree, () => (st.setupDone = true));
  }

  private async runSetup(dir: string, done: () => void) {
    for (const cmd of this.m.setup) {
      let r = await sh(cmd, dir, 1800);
      if (r.code !== 0) {
        // Równoległe setupy (pnpm install, turbo) potrafią się chwilowo pogryźć o wspólne pliki — jedna powtórka przed odłożeniem toru.
        this.log(`setup w ${dir} nie przeszedł (${r.code}) — powtarzam za 30 s: ${r.out.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
        await sleep(30_000);
        r = await sh(cmd, dir, 1800);
      }
      if (r.code !== 0) throw new Error(`setup → ${r.code}: ${r.out.trim().split('\n').slice(-6).join(' | ').slice(0, 600)}\n(polecenie: ${cmd.slice(0, 200)})`);
    }
    done();
    this.store.save();
  }

  // ───────────────────────────── scalanie ─────────────────────────────

  private integrationDir = (wave: Wave) => join(this.m.worktreeRoot, `_integration-${wave.id}`);

  private async ensureIntegration(wave: Wave) {
    const iwt = this.integrationDir(wave);
    const ib = `integration/${wave.id}`;
    const ws = this.store.wave(wave.id);
    if (await this.isWorktreeOn(iwt, ib)) {
      if (!ws.integrationSetupDone) await this.runSetup(iwt, () => (ws.integrationSetupDone = true));
      return;
    }
    await this.waitForDisk(`integracja ${wave.id}`);
    await this.repoLock.run(async () => {
      if (existsSync(iwt)) renameSync(iwt, `${iwt}.stale-${Date.now()}`);
      await sh('git worktree prune', this.m.repo);
      // Integracja zawsze od aktualnego main; stara gałąź integracji o tej nazwie jest przestawiana (-B).
      await git(this.m.repo, `worktree add -B ${q(ib)} ${q(iwt)} ${q(this.m.mainBranch)}`);
      ws.integrationSetupDone = false;
      this.store.save();
    });
    await this.runSetup(iwt, () => (ws.integrationSetupDone = true));
  }

  private async mergeWave(wave: Wave, ready: TrackState[]) {
    const ws = this.store.wave(wave.id);
    const resumingMerge = ws.status === 'merging' && !!ws.mergeSessionId;
    ws.status = 'merging';
    const ib = `integration/${wave.id}`;
    const iwt = this.integrationDir(wave);
    ws.integrationBranch = ib;
    this.store.save();
    await this.ensureIntegration(wave);
    const main = this.m.mainBranch;
    const baselineRed = ws.baselineRed ?? [];
    const gates = wave.integrationGates ?? wave.gates ?? [];

    let sessionId: string | undefined = ws.mergeSessionId;
    const common = {
      ...this.baseSpec(`scalanie-${wave.id}`, iwt, null, this.m.models.merge ?? this.m.models.track),
      onSessionId: (id: string) => {
        ws.mergeSessionId = id;
        this.store.save();
      },
    };
    const talk = async (prompt: string) => {
      const out = await runSession({ ...common, prompt, resume: sessionId }, this.store);
      sessionId = out.sessionId ?? sessionId;
      return out;
    };
    const rules = (list: TrackState[]) => `# Scalanie fali ${wave.id} (tryb autonomiczny)
Jesteś w worktree \`${iwt}\` na gałęzi \`${ib}\` (odbitej od \`${main}\`). Człowieka nie ma; pytania → AskUserQuestion (nadzorca).
Gałęzie do scalenia (zielone tory): ${list.map((s) => `\`${s.branch}\``).join(', ')}.
Scalaj je do BIEŻĄCEJ gałęzi (\`git merge --no-ff <gałąź>\`), rozwiązuj konflikty tak, żeby zachować intencję OBU stron, commituj.
Do \`${main}\` NIE scalasz i nic nie pushujesz — dyrygent przewinie \`${main}\` sam po zielonych bramkach. Gałęzi nie kasujesz.
Kroki planu, które przewijają lub pushują \`${main}\`, usuwają worktree, ubijają serwery torów albo zakładają worktree NASTĘPNEJ fali — robi dyrygent; pomiń je.
Jeśli plan każe pracować w checkoutcie \`${main}\` albo na jego porcie — pracujesz w TYM worktree integracji, a swój serwer dev stawiasz na porcie **${this.m.mergePort}** (w tle).${this.m.sessionCwd ? ` Sesja startuje w \`${this.m.sessionCwd}\`, pracę robisz w \`cd "${iwt}"\`.` : ''}
Kolizje, których git nie widzi (plik skasowany po jednej stronie, import po drugiej), łapią dopiero testy — uruchom je.${baselineRed.length ? `\nBramki czerwone już na ${main} przed falą (nie blokują): ${baselineRed.join(', ')}.` : ''}
Na końcu: worktree czysty, krótki raport scalenia.

`;

    const notIn = async (list: TrackState[]) => {
      const miss: TrackState[] = [];
      for (const s of list) if (!(await gitOk(iwt, `merge-base --is-ancestor ${q(s.branch)} HEAD`))) miss.push(s);
      return miss;
    };
    const inspect = async (list: TrackState[]) => {
      const miss = await notIn(list);
      const merging = existsSync(join(await git(iwt, 'rev-parse --absolute-git-dir'), 'MERGE_HEAD'));
      const dirty = (await sh('git status --porcelain', iwt)).out.trim();
      const results: GateResult[] = miss.length || merging || dirty ? [] : await runGates(gates, iwt, ws.baselineFailures);
      results.push(...await protectedChanges(iwt, this.store.state.startMain, this.m.policy.protectedPaths ?? []));
      await killProcessesIn(iwt);
      const problems = [
        miss.length ? `Nie scalone gałęzie: ${miss.map((s) => s.branch).join(', ')}.` : '',
        merging ? 'Merge jest w toku (MERGE_HEAD) — dokończ go.' : '',
        dirty ? `Niezacommitowane zmiany:\n${dirty.slice(0, 1500)}` : '',
        results.length && !allGreen(results, baselineRed) ? failureReport(results, baselineRed) : '',
      ].filter(Boolean);
      return { problems, results };
    };
    /** Scala jedną gałąź; konflikt oddaje sesji. Zwraca, czy gałąź jest w integracji i nic nie wisi. */
    const mergeOne = async (s: TrackState) => {
      const r = await sh(`git merge --no-ff --no-edit ${q(s.branch)}`, iwt);
      if (r.code === 0) return this.log(`[${wave.id}] scalono ${s.branch}`);
      this.log(`[${wave.id}] konflikt przy ${s.branch} — rozwiązuje sesja`);
      await talk((sessionId ? '' : rules(ready)) + `Trwa \`git merge ${s.branch}\` i są konflikty:\n\`\`\`\n${r.out.slice(-3000)}\n\`\`\`\nRozwiąż je i dokończ TEN merge commitem. Pozostałe gałęzie scali dyrygent.`);
    };

    // 1. Zwykłe scalanie: prompt fali albo dyrygent + sesja od konfliktów, potem poprawki.
    const custom = mergePromptOf(this.m, wave);
    if (resumingMerge) {
      this.log(`[${wave.id}] wznowienie sesji scalającej`);
      await talk('Dyrygent został wznowiony po przerwie. Kontynuuj scalanie od miejsca, w którym przerwałeś (sprawdź git status i MERGE_HEAD).');
    } else if (custom) {
      this.log(`[${wave.id}] scalanie według promptu fali`);
      await talk(rules(ready) + custom);
    } else {
      for (const s of await notIn(ready)) await mergeOne(s);
    }
    let ok = false;
    for (let attempt = 0; ; attempt++) {
      const { problems, results } = await inspect(ready);
      if (problems.length === 0) {
        ws.note = `bramki integracji: ${describeGates(results, baselineRed)}`;
        ok = true;
        break;
      }
      if (attempt >= this.m.maxFixAttempts) {
        ws.note = problems.join('\n').slice(0, 1500);
        break;
      }
      this.log(`[${wave.id}] integracja czerwona — poprawka ${attempt + 1}/${this.m.maxFixAttempts}`);
      await talk((sessionId ? '' : rules(ready)) + `Dyrygent sprawdził integrację i są problemy. Napraw je (nie osłabiaj bramek), zacommituj.\n\n${problems.join('\n\n')}`);
    }

    // 2. Awaryjnie: od nowa po jednym torze; tor, który psuje bramki razem z resztą, jest odkładany (zamiast stopu całego przebiegu).
    if (!ok) {
      this.log(`[${wave.id}] scalanie całości nie przeszło — awaryjnie po jednym torze`);
      await killProcessesIn(iwt);
      await sh('git merge --abort', iwt);
      await git(iwt, `reset --hard ${q(main)}`);
      sessionId = undefined;
      ws.mergeSessionId = undefined;
      ws.collided = [];
      const merged: TrackState[] = [];
      for (const s of ready) {
        const before = await git(iwt, 'rev-parse HEAD');
        await mergeOne(s);
        const { problems } = await inspect([...merged, s]);
        if (problems.length === 0) {
          merged.push(s);
          continue;
        }
        this.log(`[${wave.id}] ${s.id} psuje integrację z resztą — odkładam`);
        await sh('git merge --abort', iwt);
        await git(iwt, `reset --hard ${before}`);
        this.defer(s, `koliduje z resztą fali przy scalaniu: ${problems.join(' ').slice(0, 400)}`);
        ws.collided.push(s.id);
      }
      ready = merged;
      if (ready.length === 0) {
        ws.status = 'merged';
        ws.note = 'żaden tor nie przeszedł integracji — main bez zmian';
        this.store.save();
        this.log(`[${wave.id}] ${ws.note}`);
        return;
      }
      const { results } = await inspect(ready);
      ws.note = `awaryjnie po jednym; bramki integracji: ${describeGates(results, baselineRed)}`;
    }

    // 3. Niezależny recenzent: pokaz zrobiony przez dyrygenta, ocena po obrazie; „fix” = jedna runda poprawek, która nie może zepsuć bramek.
    if (this.m.review && this.m.review.wave !== false) {
      const fix = ok
        ? async (issues: string[]) => {
            const before = await git(iwt, 'rev-parse HEAD');
            this.log(`[${wave.id}] recenzent: ${issues.length} usterek — runda poprawek sesji scalającej`);
            await talk(
              (sessionId ? '' : rules(ready)) +
                `Niezależny recenzent obejrzał pokaz projektu po scaleniu tej fali i wskazał usterki. Popraw te, które da się poprawić w tej fali bez przebudowy ` +
                `(zaślepki, ucięte lub nieczytelne elementy, regresje względem poprzedniej fali, AI-look w tym, co fala zmieniła), zacommituj. ` +
                `Resztę zapisz w raporcie scalenia jako otwartą — nie zaczynaj pracy kolejnej fali.\n\n${issues.map((i) => `- ${i}`).join('\n')}`,
            );
            for (let a = 0; a < 2; a++) {
              const { problems } = await inspect(ready);
              if (problems.length === 0) return true;
              if (a === 0) await talk(`Po poprawkach recenzenta integracja jest czerwona — napraw (nie osłabiaj bramek), zacommituj.\n\n${problems.join('\n\n')}`);
            }
            this.log(`[${wave.id}] poprawki recenzenta psują integrację — cofam je, fala idzie bez nich`);
            await sh('git merge --abort', iwt);
            await git(iwt, `reset --hard ${q(before)}`);
            return false;
          }
        : undefined;
      try {
        await this.waveReview(wave, iwt, fix);
      } catch (e: any) {
        this.log(`[${wave.id}] recenzja nie wyszła: ${String(e?.message ?? e).slice(0, 300)}`);
      }
    }

    await this.advanceMain(wave, iwt, ib, gates, baselineRed);
    for (const s of ready) s.status = 'merged';
    ws.status = 'merged';
    this.store.save();
    this.log(`[${wave.id}] SCALONE → ${main} = ${ws.mergeCommit?.slice(0, 10)}`);
  }

  /** Pokaz integracji + ocena recenzenta + strona „przed / po”. */
  private async waveReview(wave: Wave, iwt: string, fix?: (issues: string[]) => Promise<boolean>) {
    const ws = this.store.wave(wave.id);
    const idx = this.m.waves.indexOf(wave);
    const prevWs = this.store.state.waves.slice(0, idx).reverse().find((w) => w.showcaseDir && existsSync(w.showcaseDir));
    const prev: Shots | undefined = prevWs ? { dir: prevWs.showcaseDir!, pngs: listPngsIn(prevWs.showcaseDir!), log: '' } : undefined;
    const out = join(this.store.dir, 'showcase', wave.id);
    const take = () => takeShowcase(this.m.review!, iwt, this.reviewPort(), out);
    let shots = await take();
    if (shots.pngs.length === 0) {
      ws.review = { stars: 0, verdict: 'ok', summary: `pokaz się nie udał — brak zrzutów (${shots.log.slice(-160).replace(/\n/g, ' ')})`, issues: [] };
      this.store.save();
      this.log(`[${wave.id}] recenzja pominięta: ${ws.review.summary}`);
      return;
    }
    let rv = await this.sup.reviewWave(wave.id, shots.pngs, prev?.pngs ?? []);
    this.log(`[${wave.id}] recenzent: ${rv.stars}★ ${rv.verdict} — ${rv.summary.slice(0, 200)}`);
    if (rv.verdict === 'fix' && fix && (await fix(rv.issues))) {
      shots = await take();
      rv = await this.sup.reviewWave(wave.id, shots.pngs, prev?.pngs ?? []);
      this.log(`[${wave.id}] recenzent po poprawkach: ${rv.stars}★ ${rv.verdict}`);
    }
    const page = writeShowcasePage(join(this.store.dir, 'showcase', `${wave.id}.html`), `${this.m.name} — pokaz po fali ${wave.id}`, shots, prev, rv);
    ws.review = { ...rv, page };
    ws.showcaseDir = shots.dir;
    this.store.save();
  }

  /**
   * Przewija main --ff-only w katalogu repo. Jeśli katalog stoi na innej gałęzi albo ma zmiany,
   * które blokują przewinięcie (np. ktoś akurat w nim pracuje) — czeka, zamiast psuć cudzą pracę.
   */
  private async advanceMain(wave: Wave, iwt: string, ib: string, gates: Gate[], baselineRed: string[]) {
    const ws: WaveState = this.store.wave(wave.id);
    const main = this.m.mainBranch;
    for (let waited = 0; ; waited += WAIT_STEP_MIN) {
      const head = (await sh('git rev-parse --abbrev-ref HEAD', this.m.repo)).out.trim();
      let why = head !== main ? `katalog repo stoi na „${head}”, nie na ${main}` : '';
      if (!why) {
        const r = await sh(`git merge --ff-only ${q(ib)}`, this.m.repo);
        if (r.code === 0) break;
        const diverged = !(await gitOk(this.m.repo, `merge-base --is-ancestor ${q(main)} ${q(ib)}`));
        if (diverged) {
          // Ktoś ruszył main w trakcie fali: dociągnij go do integracji i sprawdź bramki jeszcze raz.
          this.log(`[${wave.id}] ${main} się ruszył — dociągam do integracji`);
          const mm = await sh(`git merge --no-edit ${q(main)}`, iwt);
          const again = await runGates(gates, iwt, ws.baselineFailures);
          again.push(...await protectedChanges(iwt, this.store.state.startMain, this.m.policy.protectedPaths ?? []));
          await killProcessesIn(iwt);
          if (mm.code !== 0 || !allGreen(again, baselineRed)) {
            await sh('git merge --abort', iwt);
            throw new StopRun(`${main} ruszył się w trakcie fali ${wave.id} i integracja z nim nie przechodzi — ${main} nietknięty, praca na ${ib}`);
          }
          continue;
        }
        why = `przewinięcie ${main} blokują lokalne zmiany w ${this.m.repo}: ${r.out.trim().slice(-200)}`;
      }
      if (waited >= this.m.mainBusyWaitMin) throw new StopRun(`${why} — czekałem ${waited} min; fala ${wave.id} gotowa na ${ib}`);
      this.warnOnce(`main-${wave.id}`, `${why} — czekam, aż wróci na czysty ${main}`);
      this.log(`[${wave.id}] ${why} — czekam ${WAIT_STEP_MIN} min`);
      await sleep(WAIT_STEP_MIN * 60_000);
    }
    ws.mergeCommit = await git(this.m.repo, `rev-parse ${main}`);
    if (this.m.policy.push) {
      const p = await sh(`git push origin ${q(main)}`, this.m.repo, 600);
      ws.pushed = p.code === 0;
      this.log(`[${wave.id}] push ${main}: ${ws.pushed ? 'ok' : 'NIEUDANY — ' + p.out.slice(-300)}`);
      if (!ws.pushed) this.warnOnce(`push-${wave.id}`, `push ${main} po fali ${wave.id} nieudany — praca jest lokalnie`);
    }
    this.store.save();
  }

  // ───────────────────────────── sprzątanie ─────────────────────────────

  /** Worktree znika, gdy jest czysty; gałąź znika tylko, gdy jest w main i założył ją ten przebieg. */
  private async cleanup(wave: Wave) {
    const main = this.m.mainBranch;
    const items = Object.values(this.store.state.tracks)
      .filter((s) => s.wave === wave.id)
      .filter((s) => s.ownBranch || s.status === 'merged')
      .map((s) => ({ wt: s.worktree, branch: s.branch, own: s.status === 'merged' && !!s.ownBranch, port: s.port }));
    items.push({ wt: this.integrationDir(wave), branch: `integration/${wave.id}`, own: this.store.wave(wave.id).status === 'merged', port: this.m.mergePort });
    await this.repoLock.run(async () => {
      for (const it of items) {
        if (existsSync(it.wt)) {
          const killed = [...(await killProcessesIn(it.wt)), ...(it.port ? await killPort(it.port) : [])];
          if (killed.length) this.log(`sprzątanie: ubito ${killed.length} proces(ów) w ${it.wt}`);
          const r = await sh(`git worktree remove ${q(it.wt)}`, this.m.repo);
          if (r.code === 0) this.log(`sprzątanie: usunięto worktree ${it.wt}`);
          else {
            // Windows: git wyrejestrował worktree, ale nie skasował katalogu (zablokowane pliki, ścieżki > 260 znaków).
            await sh('git worktree prune', this.m.repo);
            const still = (await sh('git worktree list --porcelain', this.m.repo)).out.replace(/\\/g, '/').includes(it.wt.replace(/\\/g, '/'));
            const gone = !still && (await removeDirHard(it.wt));
            this.log(gone ? `sprzątanie: usunięto worktree ${it.wt} (dociśnięte po „${r.out.trim().slice(0, 80)}”)` : `sprzątanie: worktree ${it.wt} zostaje (${r.out.trim().slice(0, 160)})`);
          }
        }
        if (it.own && (await gitOk(this.m.repo, `merge-base --is-ancestor ${q(it.branch)} ${q(main)}`))) {
          await sh(`git branch -d ${q(it.branch)}`, this.m.repo);
        }
      }
      await sh('git worktree prune', this.m.repo);
    });
  }
}

/** PNG-i z katalogu pokazu (rekurencyjnie, posortowane). */
function listPngsIn(dir: string): string[] {
  return (readdirSync(dir, { recursive: true } as any) as any[])
    .map(String)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort()
    .map((f) => join(dir, f));
}

/** Gałąź `prestart/<key>` od `main` ze scalonymi `branches` (tymczasowy worktree, potem sprzątany). SHA albo undefined przy konflikcie. */
export async function prestartBranch(repo: string, worktreeRoot: string, main: string, key: string, branches: string[], log: (l: string) => void = () => {}): Promise<string | undefined> {
  if (branches.length === 0) return git(repo, `rev-parse ${q(main)}`);
  const br = `prestart/${key}`;
  const dir = join(worktreeRoot, `_prestart-${key}`);
  await sh('git worktree prune', repo);
  if (existsSync(dir)) await removeDirHard(dir);
  await git(repo, `worktree add -B ${q(br)} ${q(dir)} ${q(main)}`);
  let sha: string | undefined;
  try {
    let ok = true;
    for (const b of branches) {
      const r = await sh(`git merge --no-ff --no-edit ${q(b)}`, dir);
      if (r.code !== 0) {
        await sh('git merge --abort', dir);
        log(`[${key}] prestart: konflikt przy ${b}`);
        ok = false;
        break;
      }
    }
    if (ok) sha = await git(dir, 'rev-parse HEAD');
  } finally {
    await sh(`git worktree remove --force ${q(dir)}`, repo);
    await sh('git worktree prune', repo);
    if (existsSync(dir)) await removeDirHard(dir);
  }
  return sha;
}
