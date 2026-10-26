import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';

export interface ShResult {
  code: number;
  out: string;
}

export const IS_WIN = process.platform === 'win32';

/**
 * PowerShell pełną ścieżką: w powłoce dyrygenta (bash -lc z Git for Windows) `powershell` bywa poza PATH —
 * wtedy ubijanie procesów i usuwanie katalogów po cichu nic nie robiło (zmierzone 2026-10-03).
 */
const PS = IS_WIN ? `${(process.env.SystemRoot ?? 'C:/Windows').replace(/\\/g, '/')}/System32/WindowsPowerShell/v1.0/powershell.exe` : 'powershell';

/**
 * Powłoka przebiegu. Na macOS `/bin/zsh`. Na Windowsie bash z Git for Windows —
 * cały dyrygent (bramki, `q()`, `df`, potoki) mówi po POSIX-owemu, więc cmd.exe
 * ani PowerShell nie wchodzą w grę. `CONDUCT_SHELL` nadpisuje wybór.
 */
function shellPath(): string {
  if (process.env.CONDUCT_SHELL) return process.env.CONDUCT_SHELL;
  if (!IS_WIN) return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const candidates = [
    `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
    `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Git\\bin\\bash.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`,
  ];
  return candidates.find((p) => existsSync(p)) ?? 'bash';
}

export const SHELL = shellPath();

/** Polecenie powłoki z limitem czasu; stdout+stderr razem, ucięte do ostatnich `keep` znaków. */
export function sh(cmd: string, cwd: string, timeoutSec = 1800, keep = 20000): Promise<ShResult> {
  return new Promise((done) => {
    const child = spawn(SHELL, ['-lc', cmd], { cwd, env: cleanEnv() });
    let out = '';
    const add = (d: Buffer) => {
      out += d.toString();
      if (out.length > keep * 2) out = out.slice(-keep);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      out += `\n[dyrygent] przekroczony limit ${timeoutSec} s — przerwane`;
      // Windows: SIGTERM ubija tylko bash, a jego dzieci (git czekający na logowanie) trzymają potoki i `close` nie przychodzi.
      if (IS_WIN && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }, timeoutSec * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: 1, out: `Cannot start shell in ${cwd}: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, out: out.slice(-keep) });
    });
  });
}

export async function git(repo: string, args: string): Promise<string> {
  const r = await sh(`git ${args}`, repo, 600);
  if (r.code !== 0) throw new Error(`git ${args} (w ${repo}) → ${r.code}\n${r.out}`);
  return r.out.trim();
}

export async function gitOk(repo: string, args: string): Promise<boolean> {
  return (await sh(`git ${args}`, repo, 600)).code === 0;
}

/** Środowisko bez zmiennych sesji-rodzica, żeby zagnieżdżone sesje nie myślały, że są w cudzym oknie. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const keep = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']);
  for (const k of Object.keys(env)) if ((k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) && !keep.has(k)) delete env[k];
  // Nikt nie odpowie na okno logowania gita (Git Credential Manager) — push ma się nie udać od razu, a nie wisieć godzinę.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/**
 * Usuwa katalog, który przestał być worktree (git go wyrejestrował, ale nie skasował: zablokowane pliki albo ścieżki
 * dłuższe niż 260 znaków na Windowsie). Wołać tylko dla katalogów, których git już nie zna.
 */
export async function removeDirHard(dir: string): Promise<boolean> {
  for (let i = 0; i < 3 && existsSync(dir); i++) {
    // Node: nie podąża za junction pointami pnpm (lstat) i obsługuje długie ścieżki na Windowsie.
    // PowerShell 5.1 Remove-Item -Recurse na junctionach pnpm się wykłada — zmierzone 2026-10-03 (35 tys. plików w 19 s).
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch {
      /* zablokowane pliki — dobijemy procesy i spróbujemy jeszcze raz */
      await killProcessesIn(dir);
    }
    if (existsSync(dir)) await new Promise((r) => setTimeout(r, 5000));
  }
  return !existsSync(dir);
}

/** Semafor: wspólny limit równoległych torów dla bieżącej fali i torów startujących wcześniej. */
export class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Ubija procesy, których katalog roboczy albo wiersz poleceń leży w `dir` — serwery dev i watchery zostawione
 * przez sesję (inaczej zombie trzymają port i pliki, a `git worktree remove` się nie udaje).
 * `lsof -d cwd` zamiast `lsof +D`, bo +D przeszukuje node_modules i trwa minuty.
 */
export async function killProcessesIn(dir: string): Promise<number[]> {
  if (IS_WIN) return killProcessesInWin(dir);
  const mine = new Set([process.pid, process.ppid]);
  const pids = new Set<number>();
  // lsof podaje ścieżkę po rozwiązaniu dowiązań (/var → /private/var, /tmp → /private/tmp) — porównuj obie.
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    /* katalogu już nie ma */
  }
  const inside = (p: string) => [dir, real].some((d) => p === d || p.startsWith(d + '/'));
  const cwd = await sh('lsof -d cwd -Fpn 2>/dev/null', '/', 60, 5_000_000);
  let pid = 0;
  for (const line of cwd.out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && inside(line.slice(1))) pids.add(pid);
  }
  for (const d of new Set([dir, real])) {
    const pg = await sh(`pgrep -f ${q(d + '/')}`, '/', 30);
    for (const p of pg.out.split(/\s+/).filter(Boolean)) pids.add(Number(p));
  }
  const list = [...pids].filter((p) => p > 1 && !mine.has(p));
  if (list.length === 0) return [];
  await sh(`kill ${list.join(' ')} 2>/dev/null; sleep 3; kill -9 ${list.join(' ')} 2>/dev/null; true`, '/', 30);
  return list;
}

/**
 * Windowsowy odpowiednik: `lsof -d cwd` nie ma odpowiednika bez dodatkowych narzędzi
 * (katalogu roboczego procesu nie da się odczytać z Win32_Process), więc dopasowujemy
 * po WIERSZU POLECEŃ — obie postacie separatora. To łapie serwery dev i watchery
 * uruchomione ze ścieżką w argumentach; proces odpalony samym `cd` do worktree
 * może zostać. Dlatego dyrygent na Windowsie dokłada ubijanie po porcie toru.
 */
async function killProcessesInWin(dir: string): Promise<number[]> {
  const mine = new Set([process.pid, process.ppid]);
  const back = dir.replace(/\//g, '\\');
  const fwd = dir.replace(/\\/g, '/');
  const ps =
    `$a='${back.replace(/'/g, "''")}'.ToLower(); $b='${fwd.replace(/'/g, "''")}'.ToLower(); ` +
    // Bez samego siebie: wiersz polecenia tego PowerShella (i powłoki, która go woła) też zawiera szukaną ścieżkę.
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and ` +
    `-not $_.CommandLine.Contains('Get-CimInstance') -and ` +
    `($_.CommandLine.ToLower().Contains($a) -or $_.CommandLine.ToLower().Contains($b)) } | ` +
    `ForEach-Object { $_.ProcessId }`;
  const found = await sh(`${PS} -NoProfile -NonInteractive -Command ${q(ps)}`, '/', 60, 200_000);
  const list = [
    ...new Set(
      found.out
        .split(/\s+/)
        .map((s) => Number(s.trim()))
        .filter((p) => Number.isFinite(p) && p > 4 && !mine.has(p)),
    ),
  ];
  if (list.length === 0) return [];
  await sh(
    `${PS} -NoProfile -NonInteractive -Command ${q(`Stop-Process -Id ${list.join(',')} -Force -ErrorAction SilentlyContinue`)}`,
    '/',
    60,
  );
  return list;
}

/** Ubija to, co słucha na porcie toru — Windowsowe uzupełnienie dopasowania po wierszu poleceń. */
export async function killPort(port: number): Promise<number[]> {
  if (!IS_WIN) {
    const r = await sh(`lsof -ti tcp:${port} 2>/dev/null || true`, '/', 30);
    const list = r.out.split(/\s+/).map(Number).filter(Boolean);
    if (list.length) await sh(`kill -9 ${list.join(' ')} 2>/dev/null; true`, '/', 30);
    return list;
  }
  const ps =
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique`;
  const found = await sh(`${PS} -NoProfile -NonInteractive -Command ${q(ps)}`, '/', 60);
  const list = [...new Set(found.out.split(/\s+/).map(Number).filter((p) => p > 4))];
  if (list.length)
    await sh(
      `${PS} -NoProfile -NonInteractive -Command ${q(`Stop-Process -Id ${list.join(',')} -Force -ErrorAction SilentlyContinue`)}`,
      '/',
      60,
    );
  return list;
}

/** Wolne GB na wolumenie, na którym leży `dir`. */
export async function freeGb(dir: string): Promise<number> {
  const r = await sh(`df -k ${q(dir)} | tail -1 | awk '{print $4}'`, '/', 30);
  const kb = Number(r.out.trim());
  return Number.isFinite(kb) ? kb / 1024 / 1024 : Infinity;
}

/** Prosty mutex: operacje na wspólnym repo (worktree add/remove, gałęzie) po jednej naraz — git trzyma lock. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
