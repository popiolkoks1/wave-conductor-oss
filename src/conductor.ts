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
  /** Serialize operations on shared .git state, including worktrees and branches. */
  private repoLock = new Mutex();
  private warned = new Set<string>();
  /** Shared concurrency limit for current-wave and early-start tracks. */
  private slots: Semaphore;
  /** Reuse one in-flight promise per track to prevent duplicate execution. */
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

  /** Notify once per environment problem rather than on every retry. */
  private warnOnce(key: string, msg: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    void this.notifier.send('problem', msg);
  }

  async run(): Promise<void> {
    mkdirSync(this.m.worktreeRoot, { recursive: true });
    // Terminate orphaned sessions that might still write into worktrees after a conductor crash.
    for (const t of Object.values(this.store.state.tracks)) {
      if (t.status !== 'running' || !existsSync(t.worktree)) continue;
      const k = await killProcessesIn(t.worktree);
      if (k.length) this.log(`[${t.id}] resume: terminated ${k.length} orphaned processes from the previous conductor`);
    }
    for (const w of this.m.waves) if (this.store.wave(w.id).status === 'merging') await killProcessesIn(this.integrationDir(w));
    // Finish cleanup interrupted by a crash or locked files on Windows.
    for (const w of this.m.waves) {
      if (this.store.wave(w.id).status !== 'merged') continue;
      const dirs = [this.integrationDir(w), ...Object.values(this.store.state.tracks).filter((t) => t.wave === w.id).map((t) => t.worktree)];
      if (dirs.some((d) => existsSync(d))) {
        this.log(`pending cleanup after wave ${w.id}`);
        await this.cleanup(w);
      }
    }
    const beat = setInterval(() => void this.notifier.heartbeat(() => this.statusLine()), 10 * 60_000);
    try {
      for (const wave of this.m.waves) {
        if (this.store.wave(wave.id).status === 'merged') continue;
        this.checkBudget();
        this.log(`══ WAVE ${wave.id} ══`);
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
      this.store.state.stopReason = e instanceof StopRun ? e.message : `conductor error: ${e?.stack ?? e}`;
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
    return `current wave ${cur?.id ?? '—'} (${done}/${s.waves.length} complete): ${n('running')} running, ${n('green')} passing, ${n('deferred')} deferred · $${s.costUsd.toFixed(0)}`;
  }

  private waveLine(wave: Wave): string {
    const s = this.store.state;
    const ws = this.store.wave(wave.id);
    const ts = Object.values(s.tracks).filter((t) => t.wave === wave.id);
    const merged = ts.filter((t) => t.status === 'merged').length;
    const deferred = ts.filter((t) => t.status === 'deferred').map((t) => t.id);
    const idx = s.waves.findIndex((w) => w.id === wave.id) + 1;
    const rv = ws.review ? `, reviewer ${ws.review.stars}★${ws.review.page ? ` — showcase: ${ws.review.page}` : ''}` : '';
    return `wave ${wave.id} (${idx}/${s.waves.length}): integrated ${merged}/${wave.tracks.length}${deferred.length ? `, deferred: ${deferred.join(', ')}` : ''}${ws.baselineRed?.length ? `, gates already failing on main: ${ws.baselineRed.join(', ')}` : ''}${rv}`;
  }

  private checkBudget() {
    const cap = this.m.maxRunBudgetUsd;
    if (cap && this.store.state.costUsd >= cap) throw new StopRun(`run budget exceeded $${cap} (spent ~$${this.store.state.costUsd.toFixed(2)})`);
  }

  // Wave execution.

  /** Offset early-start ports to avoid conflicts with the current wave. */
  private units(wave: Wave, early = false): Unit[] {
    const out: Unit[] = [];
    let i = 0;
    for (const t of wave.tracks) {
      for (const v of t.variants ?? [undefined]) {
        // Early tracks from adjacent waves may overlap; reserve a separate block of ten ports for each wave.
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

  /** Run each track once per process under the shared concurrency limit. */
  private launch(u: Unit, base: string): Promise<void> {
    const have = this.inflight.get(u.key);
    if (have) return have;
    const st = this.ensureState(u);
    if (st.port) u.port = st.port;
    const p = this.slots
      .run(() => this.runUnit(u, base))
      .catch((e) => {
        if (e instanceof StopRun) throw e;
        this.defer(this.store.track(u.key), `conductor exception: ${String(e?.message ?? e).slice(0, 500)}`);
      })
      .finally(async () => {
        this.inflight.delete(u.key);
        if (!u.track.done) {
          await killProcessesIn(this.store.track(u.key).worktree);
          await killPort(u.port);
        }
        void this.tryEarly(u.wave).catch((e) => this.log(`early start: ${String(e?.message ?? e).slice(0, 300)}`));
      });
    this.inflight.set(u.key, p);
    return p;
  }

  // Early start based on dependencies.

  /** A dependency is ready when its track passes or is integrated and any variants are resolved. */
  private needState(id: string): { ready: boolean; branch?: string; merged: boolean } {
    const all = Object.values(this.store.state.tracks).filter((t) => t.id === id || t.id.startsWith(`${id}--`));
    if (all.length === 0) return { ready: false, merged: false };
    const merged = all.find((t) => t.status === 'merged');
    if (merged) return { ready: true, merged: true };
    if (all.some((t) => t.status === 'pending' || t.status === 'running')) return { ready: false, merged: false };
    const green = all.filter((t) => t.status === 'green');
    // Variants are resolved when exactly one passing candidate remains.
    if (green.length === 1) return { ready: true, branch: green[0].branch, merged: false };
    return { ready: false, merged: false };
  }

  /** Start eligible tracks from the next wave without waiting for the current wave to finish. */
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
          this.warnOnce(`early-${u.key}`, `early start ${u.key} unavailable (dependency conflict) — waiting for wave ${next.id}`);
          continue;
        }
      }
      if (this.inflight.has(u.key)) continue;
      st.early = true;
      st.port ??= u.port;
      st.baseSha = base;
      this.store.save();
      this.log(`[${u.key}] ⚡ early start — dependencies ready: ${needs.join(', ')}`);
      void this.launch(u, base);
    }
  }

  /** Build prestart/<track> from main plus passing dependency branches. Return undefined on conflict. */
  private prestart(key: string, branches: string[]): Promise<string | undefined> {
    return this.repoLock.run(() => prestartBranch(this.m.repo, this.m.worktreeRoot, this.m.mainBranch, key, branches, (l) => this.log(l)));
  }

  private async runWave(wave: Wave) {
    const ws = this.store.wave(wave.id);
    const base = await git(this.m.repo, `rev-parse ${this.m.mainBranch}`);
    const units = this.units(wave);
    for (const u of units) this.ensureState(u);

    // Measure baseline gates on clean main before starting any tracks.
    const iwt = this.integrationDir(wave);
    if (ws.status === 'pending') {
      await this.ensureIntegration(wave);
      const gates = baselineGatesOf(wave);
      if (gates.length) {
        this.log(`[${wave.id}] baseline gate measurement on ${this.m.mainBranch}`);
        const base0 = await runGates(gates, iwt);
        ws.baselineRed = base0.filter((r) => !r.ok && !gates.find((g) => g.name === r.name)?.failuresFile).map((r) => r.name);
        ws.baselineFailures = Object.fromEntries(base0.filter((r) => r.failures).map((r) => [r.name, r.failures!]));
        if (ws.baselineRed.length) this.log(`[${wave.id}] already failing on ${this.m.mainBranch} (informational for this wave): ${ws.baselineRed.join(', ')}`);
      }
      await killProcessesIn(iwt);
    }
    ws.status = 'tracks';
    this.store.save();

    // Start next-wave tracks immediately when their dependencies are already ready, including after resume.
    await this.tryEarly(wave).catch((e) => this.log(`early start: ${String(e?.message ?? e).slice(0, 300)}`));
    // Start in manifest order; current-wave tracks enter the semaphore queue before early tracks.
    await Promise.all(units.map((u) => this.launch(u, u.track.base ?? this.store.track(u.key).baseSha ?? base)));

    // Choose one passing variant; retain alternative branches.
    for (const t of wave.tracks.filter((t) => t.variants)) {
      const green = t.variants!.map((v) => this.store.track(`${t.id}--${v.id}`)).filter((s) => s.status === 'green');
      if (green.length >= 2) {
        const visual = this.m.review && this.m.review.judge !== false;
        const shots = new Map<string, string[]>();
        if (visual) {
          for (const s of green) {
            const sh0 = await takeShowcase(this.m.review!, s.worktree, this.reviewPort(), join(this.store.dir, 'showcase', s.id));
            this.log(`[${s.id}] showcase for judge: ${sh0.pngs.length} screenshots${sh0.pngs.length ? '' : ` — ${sh0.log.slice(-200)}`}`);
            shots.set(s.id, sh0.pngs);
          }
        }
        const r = await this.sup.judge(
          t.id,
          t.judgeCriteria ?? '',
          green.map((s) => ({ id: s.variant!, branch: s.branch, worktree: s.worktree, gates: s.reason ?? '', summary: s.summary ?? '', shots: shots.get(s.id) })),
        );
        for (const s of green) if (s.variant !== r.winner) { s.status = 'lost-variant'; s.reason = `lost to ${r.winner}: ${r.reason}`; }
        this.log(`[${t.id}] winning variant ${r.winner}`);
      }
      this.store.save();
    }
    await this.tryEarly(wave).catch((e) => this.log(`early start: ${String(e?.message ?? e).slice(0, 300)}`));

    // Do not integrate an early track whose dependencies were excluded from main; it would reintroduce them.
    for (const u of units) {
      const st = this.store.track(u.key);
      if (!st.early || st.status !== 'green') continue;
      const missing = (u.track.needs ?? []).filter((n) => !this.needState(n).merged);
      if (missing.length) this.defer(st, `started early from ${missing.join(', ')}, but those tracks were not integrated into ${this.m.mainBranch} — branch retained for manual review`);
    }

    for (const t of wave.tracks.filter((t) => t.required)) {
      const mine = units.filter((u) => u.track === t).map((u) => this.store.track(u.key));
      if (!mine.some((x) => x.status === 'green' || x.status === 'merged'))
        throw new StopRun(`required track ${t.id} failed: ${mine.map((x) => x.reason).join(' | ').slice(0, 300)}`);
    }

    const ready = units.map((u) => this.store.track(u.key)).filter((s) => s.status === 'green');
    if (ready.length === 0) {
      ws.status = 'merged';
      ws.note = 'no tracks passed — nothing integrated';
      this.store.save();
      this.log(`[${wave.id}] ${ws.note}`);
    } else {
      await this.mergeWave(wave, ready);
    }
    await this.cleanup(wave);
  }

  // Track execution.

  private preamble(u: Unit, st: TrackState, base: string, gates: Gate[], baselineRed: string[]): string {
    const ctx = this.m.context.map((c) => `- ${join(this.m.planDir, c)}`).join('\n');
    return `# Autonomous mode (wave conductor)
Work without human interaction. The owner delegated decisions to the supervisor.
- Track: **${u.track.id}**${u.variant ? ` — variant **${u.variant.id}**: ${u.variant.note}` : ''} (wave ${u.wave.id}).
- Your worktree: \`${st.worktree}\`, branch \`${st.branch}\`, base \`${base.slice(0, 10)}\`. Other tracks run concurrently in other directories; do not modify them.${this.m.sessionCwd ? `\n- The session starts in \`${this.m.sessionCwd}\` (project hooks), but perform ALL work in the worktree: \`cd "${st.worktree}"\` (quote the path).` : ''}
- If the plan asks you to use another directory, branch or port (such as the checkout of \`${this.m.mainBranch}\`), use THIS worktree, THIS branch and THIS port. \`git push\` is handled by the conductor after gates pass.${[...(this.m.policy.denyPaths ?? []), ...(u.track.denyPaths ?? [])].length ? `\n- Writing to these paths is blocked: ${[...(this.m.policy.denyPaths ?? []), ...(u.track.denyPaths ?? [])].join(', ')}.` : ''}
- If you need a dev server, use port **${u.port}**, run it in the BACKGROUND (never in foreground — a session longer than ${this.m.sessionTimeoutMin} min is interrupted). The conductor terminates it after your track.
- Read the plan context first:\n${ctx || '- (none)'}
- For questions or decisions (including owner review, concept approval and A/B choices), use **AskUserQuestion**; the supervisor answers, and you continue accordingly. Do not ask questions in plain text or end the session to wait.
- Make small commits on your branch, staging paths EXPLICITLY. Do not push, merge into the main branch, switch branches or delete branches/worktrees; the conductor handles these operations. Forbidden commands will be denied.
- Gates the conductor will run in your worktree: ${gates.map((g) => `\`${g.run}\``).join(', ') || '(none)'}. Run them before finishing.${baselineRed.length ? `\n- These gates already failed on clean main and do not block you (do not fix them unless that is your task): ${baselineRed.join(', ')}.` : ''}
- Skip irreversible operations (publishing, external delivery) and record them as open issues.
- For speed, run independent long tasks (variant simulations, generation batches, measurements across views) concurrently, in the background or with subagents (Agent tool).
- Finish with a short summary of completed work and open issues. Leave a clean worktree with all work committed. Write all summaries and open issues in English.

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
    if (this.m.maxRunBudgetUsd && this.store.state.costUsd >= this.m.maxRunBudgetUsd) return this.defer(st, 'run budget exhausted before track startup');
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
      return this.defer(st, `could not create worktree: ${String(e.message).slice(0, 300)}`);
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
    if (resumed) await talk('The conductor resumed after an interruption. Continue the task from where you left off.');
    else await talk(this.preamble(u, st, base, gates, baselineRed) + task, true);

    // Ask the supervisor whether the session actually finished, rather than asking a human.
    const settle = async () => {
      for (let i = 0; i < this.m.maxFollowUps; i++) {
        const r = await this.sup.review(u.key, task, out.text);
        st.summary = r.summary;
        if (r.status === 'done') return;
        if (r.status === 'blocked') this.log(`[${u.key}] blocked: ${r.reply.slice(0, 200)}`);
        this.log(`[${u.key}] supervisor responds and resumes the session`);
        await talk(r.reply);
      }
    };
    await settle();

    for (let attempt = 0; ; attempt++) {
      st.attempts = attempt;
      await killProcessesIn(st.worktree);
      const dirty = (await sh('git status --porcelain', st.worktree)).out.trim();
      if (dirty) {
        if (attempt >= this.m.maxFixAttempts) return this.defer(st, `worktree still dirty after ${attempt} attempts:\n${dirty.slice(0, 500)}`);
        this.log(`[${u.key}] uncommitted changes — asking the session to commit them`);
        await talk(`Conductor: the worktree has uncommitted changes:\n${dirty.slice(0, 2000)}\nCommit relevant work (stage explicit paths) and ignore or remove generated files. Leave the worktree clean.`);
        continue;
      }
      const results = await runGates(gates, st.worktree, ws.baselineFailures);
      await killProcessesIn(st.worktree);
      results.push(...await protectedChanges(st.worktree, st.baseSha ?? base, this.m.policy.protectedPaths ?? []));
      st.reason = describeGates(results, baselineRed);
      this.store.save();
      if (allGreen(results, baselineRed)) break;
      if (attempt >= this.m.maxFixAttempts) return this.defer(st, `gates failing after ${attempt} fix attempts: ${st.reason}`);
      this.log(`[${u.key}] gates: ${st.reason} — fix ${attempt + 1}/${this.m.maxFixAttempts}`);
      await talk(`The conductor ran the gates in your worktree and some failed. Fix the cause without weakening the gates, commit and rerun them.\n\n${failureReport(results, baselineRed)}`);
      await settle();
    }

    st.commits = Number(await git(st.worktree, `rev-list --count ${st.baseSha ?? base}..HEAD`));
    st.status = 'green';
    st.finishedAt = new Date().toISOString();
    this.store.save();
    this.log(`[${u.key}] PASSING — ${st.commits} commits, ${st.reason}`);
    if (this.m.policy.push) {
      // Back up track branches on origin when enabled; never force-push.
      const p = await sh(`git push -u origin ${q(st.branch)}`, st.worktree, 600);
      this.log(`[${u.key}] push ${st.branch}: ${p.code === 0 ? 'ok' : 'FAILED — ' + p.out.trim().slice(-200)}`);
    }
  }

  /** A pre-completed track must exist locally or on origin and goes directly to integration. */
  private async adoptDone(st: TrackState) {
    const has = (ref: string) => gitOk(this.m.repo, `rev-parse --verify -q ${q(ref)}`);
    await this.repoLock.run(async () => {
      if (!(await has(`refs/heads/${st.branch}`))) {
        if (await has(`refs/remotes/origin/${st.branch}`)) await git(this.m.repo, `branch ${q(st.branch)} ${q(`origin/${st.branch}`)}`);
      }
    });
    if (!(await has(`refs/heads/${st.branch}`))) return this.defer(st, `track marked done, but branch ${st.branch} does not exist locally or on origin`);
    st.ownBranch = false;
    st.commits = Number(await git(this.m.repo, `rev-list --count ${q(this.m.mainBranch)}..${q(st.branch)}`));
    st.status = 'green';
    st.reason = 'completed before the run (done)';
    this.store.save();
    this.log(`[${st.id}] completed before the run — ${st.branch}, ${st.commits} commits`);
  }

  private reviewPort = () => this.m.review?.port ?? this.m.mergePort + 5;

  private defer(st: TrackState, reason: string) {
    st.status = 'deferred';
    st.reason = reason;
    st.finishedAt ??= new Date().toISOString();
    this.store.save();
    this.log(`[${st.id}] DEFERRED: ${reason.slice(0, 300)}`);
  }

  /** Wait for disk space that other tracks may release, then stop after the configured limit. */
  private async waitForDisk(what: string) {
    for (let waited = 0; ; waited += WAIT_STEP_MIN) {
      const gb = await freeGb(this.m.worktreeRoot);
      if (gb >= this.m.minFreeGb) return;
      if (waited >= this.m.mainBusyWaitMin) throw new StopRun(`insufficient disk space (${gb.toFixed(1)} GB < ${this.m.minFreeGb} GB) — ${what}`);
      this.warnOnce('disk', `low disk space: ${gb.toFixed(1)} GB — waiting before creating another worktree`);
      this.log(`disk: ${gb.toFixed(1)} GB free < ${this.m.minFreeGb} GB — waiting ${WAIT_STEP_MIN} min (${what})`);
      await sleep(WAIT_STEP_MIN * 60_000);
    }
  }

  /** Check whether dir is a registered worktree on the expected branch. */
  private async isWorktreeOn(dir: string, branch: string) {
    if (!existsSync(join(dir, '.git'))) return false;
    const r = await sh('git rev-parse --abbrev-ref HEAD', dir);
    return r.code === 0 && r.out.trim() === branch;
  }

  /** Create a track worktree. Move stale directories aside. Recreate previously merged branches; use -r2, -r3, etc. for names occupied by unmerged work. */
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
        this.log(`[${st.id}] worktree directory did not match — moved aside to ${aside}`);
        await sh('git worktree prune', this.m.repo);
      }
      const has = (b: string) => gitOk(this.m.repo, `rev-parse --verify -q ${q(`refs/heads/${b}`)}`);
      if (!st.ownBranch && (await has(st.branch))) {
        if (await gitOk(this.m.repo, `merge-base --is-ancestor ${q(st.branch)} ${q(this.m.mainBranch)}`)) {
          const r = await sh(`git branch -d ${q(st.branch)}`, this.m.repo);
          this.log(`[${st.id}] old branch ${st.branch} was already in ${this.m.mainBranch} — ${r.code === 0 ? 'deleted' : 'retained (in use by another worktree)'}`);
        }
        let n = 2;
        const orig = st.branch;
        while (await has(st.branch)) st.branch = `${orig}-r${n++}`;
        if (st.branch !== orig) this.log(`[${st.id}] branch ${orig} contains other work — track uses ${st.branch}`);
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
        // Concurrent setup commands may contend over shared files; retry once before deferring the track.
        this.log(`setup in ${dir} failed (${r.code}) — retrying in 30 s: ${r.out.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
        await sleep(30_000);
        r = await sh(cmd, dir, 1800);
      }
      if (r.code !== 0) throw new Error(`setup → ${r.code}: ${r.out.trim().split('\n').slice(-6).join(' | ').slice(0, 600)}\n(command: ${cmd.slice(0, 200)})`);
    }
    done();
    this.store.save();
  }

  // Integration.

  private integrationDir = (wave: Wave) => join(this.m.worktreeRoot, `_integration-${wave.id}`);

  private async ensureIntegration(wave: Wave) {
    const iwt = this.integrationDir(wave);
    const ib = `integration/${wave.id}`;
    const ws = this.store.wave(wave.id);
    if (await this.isWorktreeOn(iwt, ib)) {
      if (!ws.integrationSetupDone) await this.runSetup(iwt, () => (ws.integrationSetupDone = true));
      return;
    }
    await this.waitForDisk(`integration ${wave.id}`);
    await this.repoLock.run(async () => {
      if (existsSync(iwt)) renameSync(iwt, `${iwt}.stale-${Date.now()}`);
      await sh('git worktree prune', this.m.repo);
      // Always base integration on current main; reset an old integration branch with -B.
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
      ...this.baseSpec(`integration-${wave.id}`, iwt, null, this.m.models.merge ?? this.m.models.track),
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
    const rules = (list: TrackState[]) => `# Wave integration ${wave.id} (autonomous mode)
You are in worktree \`${iwt}\` on branch \`${ib}\` (based on \`${main}\`). No human is available; direct questions to AskUserQuestion (supervisor).
Branches to integrate (passing tracks): ${list.map((s) => `\`${s.branch}\``).join(', ')}.
Merge them into the CURRENT branch (\`git merge --no-ff <branch>\`), resolve conflicts preserving the intent of BOTH sides, and commit.
Do not merge into \`${main}\` or push — the conductor advances \`${main}\` after gates pass. Do not delete branches.
Plan steps that advance or push \`${main}\`, remove worktrees, terminate track servers or create worktrees for the NEXT wave are handled by the conductor; skip them.
If the plan asks you to work in the checkout of \`${main}\` or on its port, use THIS integration worktree and start your dev server on port **${this.m.mergePort}** (in background).${this.m.sessionCwd ? ` The session starts in \`${this.m.sessionCwd}\`, do your work in \`cd "${iwt}"\`.` : ''}
Run tests to catch conflicts Git cannot detect (such as a deleted file still imported elsewhere).${baselineRed.length ? `\nGates already failing on ${main} before the wave (non-blocking): ${baselineRed.join(', ')}.` : ''}
Finish with a clean worktree and a short integration report in English.

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
        miss.length ? `Unmerged branches: ${miss.map((s) => s.branch).join(', ')}.` : '',
        merging ? 'A merge is in progress (MERGE_HEAD); finish it.' : '',
        dirty ? `Uncommitted changes:\n${dirty.slice(0, 1500)}` : '',
        results.length && !allGreen(results, baselineRed) ? failureReport(results, baselineRed) : '',
      ].filter(Boolean);
      return { problems, results };
    };
    /** Merge one branch, asking a session to resolve conflicts before checking integration. */
    const mergeOne = async (s: TrackState) => {
      const r = await sh(`git merge --no-ff --no-edit ${q(s.branch)}`, iwt);
      if (r.code === 0) return this.log(`[${wave.id}] integrated ${s.branch}`);
      this.log(`[${wave.id}] conflict in ${s.branch} — session will resolve it`);
      await talk((sessionId ? '' : rules(ready)) + `In progress: \`git merge ${s.branch}\` with conflicts:\n\`\`\`\n${r.out.slice(-3000)}\n\`\`\`\nResolve them and finish THIS merge with a commit. The conductor will merge remaining branches.`);
    };

    // First attempt: normal merge using the wave prompt or conductor, followed by repairs.
    const custom = mergePromptOf(this.m, wave);
    if (resumingMerge) {
      this.log(`[${wave.id}] resuming integration session`);
      await talk('The conductor resumed after an interruption. Continue integration from where you left off (check git status and MERGE_HEAD).');
    } else if (custom) {
      this.log(`[${wave.id}] integrating according to the wave prompt`);
      await talk(rules(ready) + custom);
    } else {
      for (const s of await notIn(ready)) await mergeOne(s);
    }
    let ok = false;
    for (let attempt = 0; ; attempt++) {
      const { problems, results } = await inspect(ready);
      if (problems.length === 0) {
        ws.note = `integration gates: ${describeGates(results, baselineRed)}`;
        ok = true;
        break;
      }
      if (attempt >= this.m.maxFixAttempts) {
        ws.note = problems.join('\n').slice(0, 1500);
        break;
      }
      this.log(`[${wave.id}] integration failed — fix ${attempt + 1}/${this.m.maxFixAttempts}`);
      await talk((sessionId ? '' : rules(ready)) + `The conductor found integration problems. Fix them without weakening gates and commit.\n\n${problems.join('\n\n')}`);
    }

    // Fallback: integrate one track at a time, deferring tracks that break combined checks.
    if (!ok) {
      this.log(`[${wave.id}] combined integration failed — retrying one track at a time`);
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
        this.log(`[${wave.id}] ${s.id} breaks integration with other tracks — deferring`);
        await sh('git merge --abort', iwt);
        await git(iwt, `reset --hard ${before}`);
        this.defer(s, `conflicts with other tracks during integration: ${problems.join(' ').slice(0, 400)}`);
        ws.collided.push(s.id);
      }
      ready = merged;
      if (ready.length === 0) {
        ws.status = 'merged';
        ws.note = 'no tracks passed integration — main unchanged';
        this.store.save();
        this.log(`[${wave.id}] ${ws.note}`);
        return;
      }
      const { results } = await inspect(ready);
      ws.note = `fallback integration one track at a time; integration gates: ${describeGates(results, baselineRed)}`;
    }

    // Independent screenshot review; one repair round must preserve passing gates.
    if (this.m.review && this.m.review.wave !== false) {
      const fix = ok
        ? async (issues: string[]) => {
            const before = await git(iwt, 'rev-parse HEAD');
            this.log(`[${wave.id}] reviewer: ${issues.length} issues — integration session will attempt fixes`);
            await talk(
              (sessionId ? '' : rules(ready)) +
                `An independent reviewer inspected the showcase after integration and identified issues. Fix those addressable within this wave without a redesign ` +
                `(placeholders, clipped or unreadable elements, regressions and generic visual artifacts in changed areas), then commit. ` +
                `Record remaining issues in the integration report; do not start work from the next wave.\n\n${issues.map((i) => `- ${i}`).join('\n')}`,
            );
            for (let a = 0; a < 2; a++) {
              const { problems } = await inspect(ready);
              if (problems.length === 0) return true;
              if (a === 0) await talk(`Integration checks failed after reviewer fixes. Repair without weakening gates and commit.\n\n${problems.join('\n\n')}`);
            }
            this.log(`[${wave.id}] reviewer fixes break integration — reverting them and proceeding without them`);
            await sh('git merge --abort', iwt);
            await git(iwt, `reset --hard ${q(before)}`);
            return false;
          }
        : undefined;
      try {
        await this.waveReview(wave, iwt, fix);
      } catch (e: any) {
        this.log(`[${wave.id}] review failed: ${String(e?.message ?? e).slice(0, 300)}`);
      }
    }

    await this.advanceMain(wave, iwt, ib, gates, baselineRed);
    for (const s of ready) s.status = 'merged';
    ws.status = 'merged';
    this.store.save();
    this.log(`[${wave.id}] INTEGRATED → ${main} = ${ws.mergeCommit?.slice(0, 10)}`);
  }

  /** Capture integration screenshots, review them and write a before/after page. */
  private async waveReview(wave: Wave, iwt: string, fix?: (issues: string[]) => Promise<boolean>) {
    const ws = this.store.wave(wave.id);
    const idx = this.m.waves.indexOf(wave);
    const prevWs = this.store.state.waves.slice(0, idx).reverse().find((w) => w.showcaseDir && existsSync(w.showcaseDir));
    const prev: Shots | undefined = prevWs ? { dir: prevWs.showcaseDir!, pngs: listPngsIn(prevWs.showcaseDir!), log: '' } : undefined;
    const out = join(this.store.dir, 'showcase', wave.id);
    const take = () => takeShowcase(this.m.review!, iwt, this.reviewPort(), out);
    let shots = await take();
    if (shots.pngs.length === 0) {
      ws.review = { stars: 0, verdict: 'ok', summary: `showcase failed — no screenshots (${shots.log.slice(-160).replace(/\n/g, ' ')})`, issues: [] };
      this.store.save();
      this.log(`[${wave.id}] review skipped: ${ws.review.summary}`);
      return;
    }
    let rv = await this.sup.reviewWave(wave.id, shots.pngs, prev?.pngs ?? []);
    this.log(`[${wave.id}] reviewer: ${rv.stars}★ ${rv.verdict} — ${rv.summary.slice(0, 200)}`);
    if (rv.verdict === 'fix' && fix && (await fix(rv.issues))) {
      shots = await take();
      rv = await this.sup.reviewWave(wave.id, shots.pngs, prev?.pngs ?? []);
      this.log(`[${wave.id}] reviewer after fixes: ${rv.stars}★ ${rv.verdict}`);
    }
    const page = writeShowcasePage(join(this.store.dir, 'showcase', `${wave.id}.html`), `${this.m.name} — showcase after wave ${wave.id}`, shots, prev, rv);
    ws.review = { ...rv, page };
    ws.showcaseDir = shots.dir;
    this.store.save();
  }

  /** Fast-forward main in its checkout. Wait when another branch or local changes block advancement, preserving other work. */
  private async advanceMain(wave: Wave, iwt: string, ib: string, gates: Gate[], baselineRed: string[]) {
    const ws: WaveState = this.store.wave(wave.id);
    const main = this.m.mainBranch;
    for (let waited = 0; ; waited += WAIT_STEP_MIN) {
      const head = (await sh('git rev-parse --abbrev-ref HEAD', this.m.repo)).out.trim();
      let why = head !== main ? `repository checkout is on „${head}”, rather than ${main}` : '';
      if (!why) {
        const r = await sh(`git merge --ff-only ${q(ib)}`, this.m.repo);
        if (r.code === 0) break;
        const diverged = !(await gitOk(this.m.repo, `merge-base --is-ancestor ${q(main)} ${q(ib)}`));
        if (diverged) {
          // If main advanced during the wave, merge it into integration and rerun checks.
          this.log(`[${wave.id}] ${main} advanced — merging into integration`);
          const mm = await sh(`git merge --no-edit ${q(main)}`, iwt);
          const again = await runGates(gates, iwt, ws.baselineFailures);
          again.push(...await protectedChanges(iwt, this.store.state.startMain, this.m.policy.protectedPaths ?? []));
          await killProcessesIn(iwt);
          if (mm.code !== 0 || !allGreen(again, baselineRed)) {
            await sh('git merge --abort', iwt);
            throw new StopRun(`${main} advanced during wave ${wave.id} and integration with it fails — ${main} unchanged; work retained on ${ib}`);
          }
          continue;
        }
        why = `fast-forwarding ${main} is blocked by local changes in ${this.m.repo}: ${r.out.trim().slice(-200)}`;
      }
      if (waited >= this.m.mainBusyWaitMin) throw new StopRun(`${why} — waited ${waited} min; wave ${wave.id} ready on ${ib}`);
      this.warnOnce(`main-${wave.id}`, `${why} — waiting for a clean checkout of ${main}`);
      this.log(`[${wave.id}] ${why} — waiting ${WAIT_STEP_MIN} min`);
      await sleep(WAIT_STEP_MIN * 60_000);
    }
    ws.mergeCommit = await git(this.m.repo, `rev-parse ${main}`);
    if (this.m.policy.push) {
      const p = await sh(`git push origin ${q(main)}`, this.m.repo, 600);
      ws.pushed = p.code === 0;
      this.log(`[${wave.id}] push ${main}: ${ws.pushed ? 'ok' : 'FAILED — ' + p.out.slice(-300)}`);
      if (!ws.pushed) this.warnOnce(`push-${wave.id}`, `push ${main} after wave ${wave.id} failed — work remains local`);
    }
    this.store.save();
  }

  // Cleanup.

  /** Remove only clean worktrees and branches created by this run that are already integrated. */
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
          if (killed.length) this.log(`cleanup: terminated ${killed.length} processes in ${it.wt}`);
          const r = await sh(`git worktree remove ${q(it.wt)}`, this.m.repo);
          if (r.code === 0) this.log(`cleanup: removed worktree ${it.wt}`);
          else {
            // Windows may unregister a worktree without deleting its directory because of locks or long paths.
            await sh('git worktree prune', this.m.repo);
            const still = (await sh('git worktree list --porcelain', this.m.repo)).out.replace(/\\/g, '/').includes(it.wt.replace(/\\/g, '/'));
            const gone = !still && (await removeDirHard(it.wt));
            this.log(gone ? `cleanup: removed worktree ${it.wt} (forced after „${r.out.trim().slice(0, 80)}”)` : `cleanup: worktree ${it.wt} retained (${r.out.trim().slice(0, 160)})`);
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

/** List PNG files recursively in sorted order. */
function listPngsIn(dir: string): string[] {
  return (readdirSync(dir, { recursive: true } as any) as any[])
    .map(String)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort()
    .map((f) => join(dir, f));
}

/** Build prestart/<key> from main plus dependency branches using a temporary worktree. Return undefined on conflict. */
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
        log(`[${key}] prestart: conflict in ${b}`);
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
