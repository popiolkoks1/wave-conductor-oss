import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export type TrackStatus = 'pending' | 'running' | 'green' | 'deferred' | 'merged' | 'lost-variant';

export interface TrackState {
  id: string;
  wave: string;
  variant?: string;
  branch: string;
  worktree: string;
  status: TrackStatus;
  sessionId?: string;
  attempts: number;
  costUsd: number;
  summary?: string;
  reason?: string;
  commits?: number;
  /** Branch created by this run; only owned branches may be deleted after integration. */
  ownBranch?: boolean;
  /** Setup completed in this worktree; interrupted installs must be retried. */
  setupDone?: boolean;
  /** Track dev server port; terminate listeners during cleanup, including on Windows where cwd matching is unavailable. */
  port?: number;
  /** Commit from which the track started, main or prestart/<id>. */
  baseSha?: string;
  /** Track started early, before the previous wave completed, using needs. */
  early?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export interface WaveReview {
  stars: number;
  verdict: 'ok' | 'fix';
  summary: string;
  issues: string[];
  /** HTML before/after showcase page. */
  page?: string;
}

export type WaveStatus = 'pending' | 'tracks' | 'merging' | 'merged' | 'failed';

export interface WaveState {
  id: string;
  status: WaveStatus;
  integrationBranch?: string;
  mergeCommit?: string;
  pushed?: boolean;
  note?: string;
  /** Legacy baseline-failing gates, informational for this wave. */
  baselineRed?: string[];
  baselineFailures?: Record<string, string[]>;
  /** Tracks deferred during fallback integration one at a time. */
  collided?: string[];
  /** Integration session ID for crash recovery. */
  mergeSessionId?: string;
  integrationSetupDone?: boolean;
  review?: WaveReview;
  /** Wave screenshot directory for comparison with the next wave. */
  showcaseDir?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RunState {
  runId: string;
  manifest: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: 'done' | 'stopped';
  stopReason?: string;
  startMain: string;
  waves: WaveState[];
  tracks: Record<string, TrackState>;
  decisions: number;
  costUsd: number;
}

/** Persist run state atomically so interruption, rate limits or sleep do not corrupt recovery. */
export class Store {
  readonly dir: string;
  state: RunState;
  /** Called after each state save and log entry for live reporting; exceptions are ignored. */
  onChange?: () => void;
  private changed() {
    try {
      this.onChange?.();
    } catch {
      /* Report errors must not interrupt execution. */
    }
  }

  constructor(stateDir: string, runId: string, init?: () => RunState) {
    this.dir = join(stateDir, runId);
    mkdirSync(join(this.dir, 'sessions'), { recursive: true });
    const f = join(this.dir, 'state.json');
    if (existsSync(f)) this.state = JSON.parse(readFileSync(f, 'utf8'));
    else if (init) this.state = init();
    else throw new Error(`No run found: ${runId} in ${stateDir}`);
    this.save();
  }

  save() {
    const f = join(this.dir, 'state.json');
    writeFileSync(f + '.tmp', JSON.stringify(this.state, null, 2));
    renameSync(f + '.tmp', f);
    this.changed();
  }

  track(key: string): TrackState {
    return this.state.tracks[key];
  }

  wave(id: string): WaveState {
    return this.state.waves.find((w) => w.id === id)!;
  }

  log(line: string) {
    const stamp = new Date().toISOString().slice(11, 19);
    const l = `${stamp} ${line}`;
    console.log(l);
    appendFileSync(join(this.dir, 'events.log'), l + '\n');
    this.changed();
  }

  sessionLog(name: string, obj: unknown) {
    appendFileSync(join(this.dir, 'sessions', `${name.replace(/[^\w.-]+/g, '_')}.jsonl`), JSON.stringify(obj) + '\n');
  }

  decision(entry: string) {
    this.state.decisions++;
    const file = join(this.dir, 'DECISIONS.md');
    const legacy = join(this.dir, 'DECYZJE.md');
    if (!existsSync(file) && existsSync(legacy)) copyFileSync(legacy, file);
    appendFileSync(file, entry + '\n\n');
    this.save();
  }

  addCost(key: string | null, usd: number) {
    this.state.costUsd += usd;
    if (key && this.state.tracks[key]) this.state.tracks[key].costUsd += usd;
    this.save();
  }
}
