import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
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
  /** gałąź założona przez ten przebieg (tylko takie dyrygent może skasować po scaleniu) */
  ownBranch?: boolean;
  /** `setup` z manifestu przeszedł w tym worktree (przerwany pnpm install = do powtórki) */
  setupDone?: boolean;
  /** port serwera dev toru — sprzątanie ubija to, co na nim słucha (Windows nie zna katalogu roboczego procesu) */
  port?: number;
  /** commit, od którego tor wystartował (main albo prestart/<id>) */
  baseSha?: string;
  /** tor wystartował przed końcem poprzedniej fali (needs) */
  early?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export interface WaveReview {
  stars: number;
  verdict: 'ok' | 'fix';
  summary: string;
  issues: string[];
  /** strona HTML z pokazem „przed / po” */
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
  /** bramki czerwone już na czystym main przed falą — tylko informacyjne w tej fali */
  baselineRed?: string[];
  baselineFailures?: Record<string, string[]>;
  /** tory odłożone przy awaryjnym scalaniu po jednym */
  collided?: string[];
  /** id sesji scalającej — wznowienie scalania po padnięciu procesu */
  mergeSessionId?: string;
  integrationSetupDone?: boolean;
  review?: WaveReview;
  /** katalog zrzutów pokazu tej fali (porównanie z następną) */
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

/** Stan przebiegu na dysku; każdy zapis atomowy, żeby przerwanie (limit, uśpienie Maca) nie psuło wznowienia. */
export class Store {
  readonly dir: string;
  state: RunState;
  /** wołane po każdym zapisie i wpisie do logu (raport na żywo); wyjątki ignorowane */
  onChange?: () => void;
  private changed() {
    try {
      this.onChange?.();
    } catch {
      /* raport nie może wywrócić przebiegu */
    }
  }

  constructor(stateDir: string, runId: string, init?: () => RunState) {
    this.dir = join(stateDir, runId);
    mkdirSync(join(this.dir, 'sessions'), { recursive: true });
    const f = join(this.dir, 'state.json');
    if (existsSync(f)) this.state = JSON.parse(readFileSync(f, 'utf8'));
    else if (init) this.state = init();
    else throw new Error(`Nie ma przebiegu ${runId} w ${stateDir}`);
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
    appendFileSync(join(this.dir, 'DECYZJE.md'), entry + '\n\n');
    this.save();
  }

  addCost(key: string | null, usd: number) {
    this.state.costUsd += usd;
    if (key && this.state.tracks[key]) this.state.tracks[key].costUsd += usd;
    this.save();
  }
}
