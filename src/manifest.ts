import { readFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import YAML from 'yaml';
import { DEFAULT_NOTIFY, type NotifyConfig } from './notify.js';

/** A shell check passes with exit code 0; runs/mustPass can tolerate noise. */
export interface Gate {
  name: string;
  run: string;
  /** Directory relative to the track or integration worktree. */
  cwd?: string;
  runs?: number;
  mustPass?: number;
  timeoutSec?: number;
  /** Measure wave/integration regression gates on clean main. Use false for new acceptance criteria that cannot pass on main. Track gates always check task goals. */
  baseline?: boolean;
  /** JSON string array of failing test IDs, relative to gate cwd. */
  failuresFile?: string;
}

export interface Variant {
  id: string;
  /** Additional prompt text describing how this variant differs. */
  note: string;
}

export interface Track {
  id: string;
  /** A prompt file relative to planDir, or an inline prompt. */
  promptFile?: string;
  prompt?: string;
  branch?: string;
  /** Starting branch; defaults to the main branch after the previous wave. */
  base?: string;
  /** Stop the run if this track still fails after all repairs. */
  required?: boolean;
  /** Run several variants; choose a winner and retain the alternative branches. */
  variants?: Variant[];
  judgeCriteria?: string;
  gates?: Gate[];
  model?: string;
  /** An existing completed branch, local or on origin, that skips agent execution and goes to integration. */
  done?: boolean;
  /** Worktree directory name under worktreeRoot; defaults to the track ID. */
  dir?: string;
  /** Dev server port; defaults to basePort plus the track index within the wave. */
  port?: number;
  /** Additional paths frozen for this track, such as math/ for frontend work. */
  denyPaths?: string[];
  /** Dependencies from earlier waves. Start when they pass and variants are resolved, using prestart/<id> = main plus dependency branches. Without needs, wait for the previous wave. */
  needs?: string[];
}

/** The conductor captures screenshots independently; the reviewer does not read track self-assessments. */
export interface Review {
  /** Additional project-specific reviewer instructions. */
  instructions?: string;
  /** Background server command in the worktree; the conductor substitutes {port}. */
  serve: string;
  /** Readiness path polled for HTTP 200; defaults to /. */
  ready?: string;
  /** Screenshot command; the conductor substitutes {url} and {out}. Write PNG files into {out}. */
  showcase: string;
  /** Criteria files relative to planDir, such as accessibility and product checklists. */
  criteria?: string[];
  /** Judge variants from screenshots rather than self-assessments; defaults to true. */
  judge?: boolean;
  /** Review each integrated wave; fix permits one integration-session repair round. Defaults to true. */
  wave?: boolean;
  /** Showcase server port; defaults to mergePort + 5. */
  port?: number;
}

export interface Wave {
  id: string;
  tracks: Track[];
  /** Gates run in every track in this wave, in addition to track gates. */
  gates?: Gate[];
  /** Optional integration prompt. Without one, the conductor merges and delegates conflicts to a session. */
  mergePromptFile?: string;
  mergePrompt?: string;
  integrationGates?: Gate[];
}

export interface Policy {
  /** Additional forbidden Bash command patterns, such as deployment scripts. */
  denyBash?: string[];
  /** Directories where sessions may write outside their worktree. */
  writeRoots?: string[];
  /** Frozen paths relative to the worktree, such as math/ or src/types/. */
  denyPaths?: string[];
  /** Push the integration target after each merged wave; never force-push. */
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
  /** Faster model for simple completion reviews; defaults to supervisor. */
  light?: string;
  /** Showcase reviewer model; defaults to judge. */
  reviewer?: string;
}

export interface Manifest {
  name: string;
  /** Project repository. */
  repo: string;
  mainBranch: string;
  /** Plan directory containing task prompts and shared rules. */
  planDir: string;
  /** Session startup directory for project hooks; work still happens in the worktree. Defaults to the worktree. */
  sessionCwd?: string;
  /** Integration session dev server port. */
  mergePort: number;
  /** Plan context files read by the supervisor and each track, relative to planDir. */
  context: string[];
  /** Root directory for track worktrees. */
  worktreeRoot: string;
  /** Run state directory. */
  stateDir: string;
  maxParallel: number;
  maxFixAttempts: number;
  maxFollowUps: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Setup commands for each new worktree, such as pnpm install. */
  setup: string[];
  /** First dev server port; track N uses basePort + N to avoid collisions. */
  basePort: number;
  /** Interrupt and resume sessions that exceed this wall-clock limit, such as a blocked dev server or commit. */
  sessionTimeoutMin: number;
  /** Estimated run cost limit; stop with a report when reached. Unset means unlimited. */
  maxRunBudgetUsd?: number;
  /** Do not create new worktrees below this many free GB. */
  minFreeGb: number;
  /** Maximum wait for the main checkout to become available before stopping the wave. */
  mainBusyWaitMin: number;
  notify: NotifyConfig;
  settingSources: ('user' | 'project' | 'local')[];
  models: Models;
  policy: Policy;
  /** Required PATH tools checked by doctor, such as node, pnpm, make or cargo. */
  requires: string[];
  review?: Review;
  /** Port offset for early-start tracks to avoid conflicts with the current wave. */
  earlyPortOffset: number;
  waves: Wave[];
  /** Directory containing the manifest. */
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
  const need = (k: string) => raw[k] === undefined && errors.push(`missing field "${k}"`);
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
  if (m.review?.instructions !== undefined && typeof m.review.instructions !== 'string') errors.push('review.instructions must be a string');
  if (m.review && (!m.review.serve || !m.review.showcase)) errors.push('review requires serve and showcase');

  if (!Number.isInteger(m.maxParallel) || m.maxParallel < 1) errors.push('maxParallel must be a positive integer');
  if (m.policy.outputBranch && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(m.policy.outputBranch)) errors.push('invalid outputBranch');
  if (m.policy.outputBranch === m.mainBranch) errors.push('outputBranch must differ from mainBranch');
  const ids = new Set<string>();
  if (!Array.isArray(m.waves) || m.waves.length === 0) errors.push('waves must be a nonempty array');
  for (const w of m.waves ?? []) {
    if (!w.id) errors.push('wave has no id');
    if (!Array.isArray(w.tracks) || w.tracks.length === 0) errors.push(`wave ${w.id}: no tracks`);
    for (const t of w.tracks ?? []) {
      if (!t.id) errors.push(`wave ${w.id}: track has no id`);
      if (ids.has(t.id)) errors.push(`duplicate track id: ${t.id}`);
      ids.add(t.id);
      if (!t.done && !t.promptFile && !t.prompt) errors.push(`track ${t.id}: promptFile or prompt is required`);
      if (t.variants && t.variants.length < 2) errors.push(`track ${t.id}: variants requires at least 2 candidates`);
      for (const g of [...(t.gates ?? [])]) checkGate(g, `track ${t.id}`, errors);
    }
    for (const g of [...(w.gates ?? []), ...(w.integrationGates ?? [])]) checkGate(g, `wave ${w.id}`, errors);
  }
  // Only earlier-wave dependencies are allowed; same-wave and forward dependencies are unsupported.
  const earlier = new Set<string>();
  for (const w of m.waves ?? []) {
    for (const t of w.tracks ?? []) for (const n of t.needs ?? []) if (!earlier.has(n)) errors.push(`track ${t.id}: needs „${n}” must reference a track from an earlier wave`);
    for (const t of w.tracks ?? []) earlier.add(t.id);
  }
  if (errors.length) throw new Error(`Manifest: ${errors.join('; ')}`);
  return m;
}

function checkGate(g: Gate, where: string, errors: string[]) {
  if (g.name === 'protected-paths') errors.push(`${where}: protected-paths is reserved`);
  if (!g.name || !g.run) errors.push(`${where}: gate requires name and run`);
  if (g.failuresFile && (isAbsolute(g.failuresFile) || g.failuresFile.split(/[\\/]/).includes('..'))) errors.push(`${where}: failuresFile must stay inside gate cwd`);
  const runs = g.runs ?? 1;
  const must = g.mustPass ?? runs;
  if (must > runs || must < 1) errors.push(`${where}/${g.name}: mustPass must be in 1..runs`);
}

/** Baseline regression gates include wave and integration gates unless baseline is false. Track goals are excluded. */
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
