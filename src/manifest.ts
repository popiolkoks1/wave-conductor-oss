import { readFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import YAML from 'yaml';
import { DEFAULT_NOTIFY, type NotifyConfig } from './notify.js';

/** Bramka: polecenie powłoki, zielone = kod wyjścia 0. `runs`/`mustPass` tłumią szum (np. testy wizualne). */
export interface Gate {
  name: string;
  run: string;
  /** katalog względem worktree toru / integracji */
  cwd?: string;
  runs?: number;
  mustPass?: number;
  timeoutSec?: number;
  /**
   * Bramka fali/integracji mierzona na czystym main przed falą; czerwona tam = w tej fali tylko informacyjna.
   * `false` dla bramek, które sprawdzają NOWĄ rzecz (cel), bo na main muszą być czerwone. Bramki toru to zawsze cele.
   */
  baseline?: boolean;
  /** JSON string array of failing test IDs, relative to gate cwd. */
  failuresFile?: string;
}

export interface Variant {
  id: string;
  /** dopisek do promptu toru: czym ten wariant różni się od innych */
  note: string;
}

export interface Track {
  id: string;
  /** plik z promptem toru (względem planDir) albo prompt wprost */
  promptFile?: string;
  prompt?: string;
  branch?: string;
  /** gałąź, od której tor startuje; domyślnie gałąź główna po poprzedniej fali */
  base?: string;
  /** czerwony po wszystkich poprawkach = koniec całego przebiegu (zamiast odłożenia toru) */
  required?: boolean;
  /** kilka wariantów tego samego toru; sędzia wybiera jeden, reszta zostaje na gałęziach */
  variants?: Variant[];
  judgeCriteria?: string;
  gates?: Gate[];
  model?: string;
  /** tor już zrobiony poza dyrygentem: gałąź istnieje (lokalnie albo na origin), sesji nie ma — idzie prosto do scalania */
  done?: boolean;
  /** nazwa katalogu worktree w worktreeRoot (domyślnie id toru) — gdy prompt planu podaje konkretny katalog */
  dir?: string;
  /** port serwera dev (domyślnie basePort + numer toru w fali) — gdy prompt planu podaje konkretny port */
  port?: number;
  /** dodatkowe zamrożone ścieżki tylko dla tego toru (np. tory frontendu nie ruszają math/) */
  denyPaths?: string[];
  /**
   * Tory z WCZEŚNIEJSZYCH fal, od których ten tor zależy. Gdy wszystkie są zielone (a dla wariantów — rozstrzygnięte),
   * tor startuje od razu, jeszcze w trakcie poprzedniej fali, od gałęzi `prestart/<id>` = main + scalone zależności.
   * Bez `needs` tor czeka na koniec poprzedniej fali (jak dotąd).
   */
  needs?: string[];
}

/** Niezależny recenzent i pokaz projektu: dyrygent sam stawia serwer, robi zrzuty i daje je recenzentowi, który nie czyta samooceny torów. */
export interface Review {
  /** Dodatkowe instrukcje recenzenta dopasowane do projektu. */
  instructions?: string;
  /** polecenie serwera w worktree, w tle; `{port}` podstawia dyrygent */
  serve: string;
  /** ścieżka sprawdzana, aż serwer odpowie 200 (domyślnie `/`) */
  ready?: string;
  /** polecenie robiące zrzuty; `{url}` i `{out}` podstawia dyrygent; PNG-i lądują w `{out}` */
  showcase: string;
  /** plik (względem planDir) z kryteriami oceny, np. checklista i kryteria projektu */
  criteria?: string[];
  /** sędzia wariantów ocenia po zrzutach, nie po samoocenie (domyślnie true) */
  judge?: boolean;
  /** po scaleniu fali: pokaz + ocena recenzenta; „fix” = jedna runda poprawek sesji scalającej (domyślnie true) */
  wave?: boolean;
  /** port serwera pokazu (domyślnie mergePort + 5) */
  port?: number;
}

export interface Wave {
  id: string;
  tracks: Track[];
  /** bramki odpalane w każdym torze tej fali (dokładane do bramek toru) */
  gates?: Gate[];
  /** prompt scalania (np. M-SCALANIE-FALI.md); bez niego dyrygent scala sam, a konflikty oddaje sesji */
  mergePromptFile?: string;
  mergePrompt?: string;
  integrationGates?: Gate[];
}

export interface Policy {
  /** dodatkowe zakazane wzorce poleceń Bash (regex) — np. skrypt wdrożenia */
  denyBash?: string[];
  /** katalogi, w których sesje mogą pisać poza własnym worktree */
  writeRoots?: string[];
  /** ścieżki (względem worktree), do których NIE wolno pisać — np. math/, src/types/ (pliki zamrożone) */
  denyPaths?: string[];
  /** dyrygent robi `git push origin <main>` po każdej scalonej fali (nigdy --force) */
  push?: boolean;
  /** Keep main untouched; run in a dedicated checkout on this branch. */
  outputBranch?: string;
  /** Git pathspecs checked after sessions, including shell-based edits. */
  protectedPaths?: string[];
}

export interface Models {
  track?: string;
  supervisor?: string;
  merge?: string;
  judge?: string;
  /** szybszy model do prostych ocen (czy sesja skończyła) — domyślnie `supervisor` */
  light?: string;
  /** recenzent pokazu (domyślnie `judge`) */
  reviewer?: string;
}

export interface Manifest {
  name: string;
  /** repozytorium projektu */
  repo: string;
  mainBranch: string;
  /** katalog planu (prompty torów, zasady wspólne) */
  planDir: string;
  /** katalog startowy sesji (np. katalog z hookami projektu); praca i tak idzie w worktree. Domyślnie worktree. */
  sessionCwd?: string;
  /** port serwera dev dla sesji scalającej */
  mergePort: number;
  /** pliki kontekstu dla nadzorcy i doklejane do każdego toru (względem planDir) */
  context: string[];
  /** gdzie zakładać worktree torów */
  worktreeRoot: string;
  /** gdzie zapisywać stan przebiegu */
  stateDir: string;
  maxParallel: number;
  maxFixAttempts: number;
  maxFollowUps: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** polecenia odpalane w każdym nowym worktree (np. pnpm install) */
  setup: string[];
  /** pierwszy port serwera dev; tor N dostaje basePort + N, żeby równoległe serwery się nie gryzły */
  basePort: number;
  /** sesja dłuższa niż tyle minut zegara ściennego jest przerywana i wznawiana (wisi na serwerze dev, na commicie…) */
  sessionTimeoutMin: number;
  /** szacowany koszt całego przebiegu, po którym dyrygent kończy (z raportem); brak = bez limitu */
  maxRunBudgetUsd?: number;
  /** poniżej tylu GB wolnego miejsca nie zakłada nowych worktree */
  minFreeGb: number;
  /** ile minut czekać, aż katalog repo wróci na czysty main, zanim fala się zatrzyma */
  mainBusyWaitMin: number;
  notify: NotifyConfig;
  settingSources: ('user' | 'project' | 'local')[];
  models: Models;
  policy: Policy;
  /** narzędzia, które muszą być na PATH (doctor sprawdza przed startem), np. node, pnpm, make, cargo */
  requires: string[];
  review?: Review;
  /** przesunięcie portów torów startujących wcześniej (`needs`), żeby nie gryzły się z torami bieżącej fali */
  earlyPortOffset: number;
  waves: Wave[];
  /** katalog, z którego wczytano manifest */
  baseDir: string;
}

const abs = (base: string, p: string) => (isAbsolute(p) ? p : resolve(base, p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')));

export function loadManifest(path: string): Manifest {
  const baseDir = dirname(resolve(path));
  const raw = YAML.parse(readFileSync(path, 'utf8')) ?? {};
  return normalizeManifest(raw, baseDir);
}

export function normalizeManifest(raw: any, baseDir: string): Manifest {
  const errors: string[] = [];
  const need = (k: string) => raw[k] === undefined && errors.push(`brak pola "${k}"`);
  ['name', 'repo', 'planDir', 'waves'].forEach(need);
  if (errors.length) throw new Error(`Manifest: ${errors.join(', ')}`);

  const repo = abs(baseDir, raw.repo);
  const planDir = abs(baseDir, raw.planDir);
  const m: Manifest = {
    name: String(raw.name),
    repo,
    mainBranch: raw.mainBranch ?? 'main',
    planDir,
    context: raw.context ?? [],
    sessionCwd: raw.sessionCwd ? abs(baseDir, raw.sessionCwd) : undefined,
    mergePort: raw.mergePort ?? (raw.basePort ?? 4100) + 90,
    worktreeRoot: abs(baseDir, raw.worktreeRoot ?? `${repo}-conductor-wt`),
    stateDir: abs(baseDir, raw.stateDir ?? '.conductor'),
    maxParallel: raw.maxParallel ?? 4,
    maxFixAttempts: raw.maxFixAttempts ?? 3,
    maxFollowUps: raw.maxFollowUps ?? 4,
    maxTurns: raw.maxTurns,
    maxBudgetUsd: raw.maxBudgetUsd,
    setup: raw.setup ?? [],
    basePort: raw.basePort ?? 4100,
    sessionTimeoutMin: raw.sessionTimeoutMin ?? 240,
    maxRunBudgetUsd: raw.maxRunBudgetUsd,
    minFreeGb: raw.minFreeGb ?? 10,
    mainBusyWaitMin: raw.mainBusyWaitMin ?? 120,
    notify: { ...DEFAULT_NOTIFY, ...(raw.notify ?? {}) },
    settingSources: raw.settingSources ?? ['project', 'local'],
    models: raw.models ?? {},
    policy: {
      denyBash: raw.policy?.denyBash ?? [],
      writeRoots: (raw.policy?.writeRoots ?? []).map((p: string) => abs(baseDir, p)),
      denyPaths: raw.policy?.denyPaths ?? [],
      push: raw.policy?.push ?? false,
      outputBranch: raw.policy?.outputBranch,
      protectedPaths: raw.policy?.protectedPaths ?? [],
    },
    requires: raw.requires ?? [],
    review: raw.review,
    earlyPortOffset: raw.earlyPortOffset ?? 50,
    waves: raw.waves,
    baseDir,
  };
  if (m.review?.instructions !== undefined && typeof m.review.instructions !== 'string') errors.push('review.instructions musi być tekstem');
  if (m.review && (!m.review.serve || !m.review.showcase)) errors.push('review wymaga serve i showcase');

  if (!Number.isInteger(m.maxParallel) || m.maxParallel < 1) errors.push('maxParallel must be a positive integer');
  if (m.policy.outputBranch && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(m.policy.outputBranch)) errors.push('invalid outputBranch');
  if (m.policy.outputBranch === m.mainBranch) errors.push('outputBranch must differ from mainBranch');
  const ids = new Set<string>();
  if (!Array.isArray(m.waves) || m.waves.length === 0) errors.push('waves musi być niepustą listą');
  for (const w of m.waves ?? []) {
    if (!w.id) errors.push('fala bez id');
    if (!Array.isArray(w.tracks) || w.tracks.length === 0) errors.push(`fala ${w.id}: brak torów`);
    for (const t of w.tracks ?? []) {
      if (!t.id) errors.push(`fala ${w.id}: tor bez id`);
      if (ids.has(t.id)) errors.push(`zdublowane id toru: ${t.id}`);
      ids.add(t.id);
      if (!t.done && !t.promptFile && !t.prompt) errors.push(`tor ${t.id}: potrzebny promptFile albo prompt`);
      if (t.variants && t.variants.length < 2) errors.push(`tor ${t.id}: variants wymaga ≥ 2 wariantów`);
      for (const g of [...(t.gates ?? [])]) checkGate(g, `tor ${t.id}`, errors);
    }
    for (const g of [...(w.gates ?? []), ...(w.integrationGates ?? [])]) checkGate(g, `fala ${w.id}`, errors);
  }
  // needs: tylko tory z wcześniejszych fal (zależność w tej samej fali nic nie przyspiesza, a w przód — nie da się)
  const earlier = new Set<string>();
  for (const w of m.waves ?? []) {
    for (const t of w.tracks ?? []) for (const n of t.needs ?? []) if (!earlier.has(n)) errors.push(`tor ${t.id}: needs „${n}” musi być torem z wcześniejszej fali`);
    for (const t of w.tracks ?? []) earlier.add(t.id);
  }
  if (errors.length) throw new Error(`Manifest: ${errors.join('; ')}`);
  return m;
}

function checkGate(g: Gate, where: string, errors: string[]) {
  if (g.name === 'protected-paths') errors.push(`${where}: protected-paths is reserved`);
  if (!g.name || !g.run) errors.push(`${where}: bramka wymaga name i run`);
  if (g.failuresFile && (isAbsolute(g.failuresFile) || g.failuresFile.split(/[\\/]/).includes('..'))) errors.push(`${where}: failuresFile must stay inside gate cwd`);
  const runs = g.runs ?? 1;
  const must = g.mustPass ?? runs;
  if (must > runs || must < 1) errors.push(`${where}/${g.name}: mustPass musi być w 1..runs`);
}

/** Bramki regresji do pomiaru bazowego: fali i integracji, bez `baseline: false`. Bramki torów to cele — nie mierzymy ich. */
export function baselineGatesOf(wave: Wave): Gate[] {
  const seen = new Map<string, Gate>();
  for (const g of [...(wave.gates ?? []), ...(wave.integrationGates ?? [])]) if (g.baseline !== false) seen.set(g.name, g);
  const own = new Set(wave.tracks.flatMap((t) => (t.gates ?? []).map((g) => g.name)));
  return [...seen.values()].filter((g) => !own.has(g.name));
}

export const branchOf = (t: Track, variant?: Variant) =>
  (t.branch ?? `wave/${t.id}`) + (variant ? `--${variant.id}` : '');

export function trackPrompt(m: Manifest, t: Track): string {
  if (t.prompt) return t.prompt;
  if (!t.promptFile) return '';
  return readFileSync(abs(m.planDir, t.promptFile!), 'utf8');
}

export function mergePromptOf(m: Manifest, w: Wave): string | undefined {
  if (w.mergePrompt) return w.mergePrompt;
  if (w.mergePromptFile) return readFileSync(abs(m.planDir, w.mergePromptFile), 'utf8');
  return undefined;
}

export function contextBundle(m: Manifest): string {
  return m.context
    .map((f) => `<<< ${f} >>>\n${readFileSync(abs(m.planDir, f), 'utf8')}`)
    .join('\n\n');
}
