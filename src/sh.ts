import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';

export interface ShResult {
  code: number;
  out: string;
}

export const IS_WIN = process.platform === 'win32';

/** Use the absolute PowerShell path because Git Bash may omit it from PATH; otherwise process termination and directory removal silently fail. */
const PS = IS_WIN ? `${(process.env.SystemRoot ?? 'C:/Windows').replace(/\\/g, '/')}/System32/WindowsPowerShell/v1.0/powershell.exe` : 'powershell';

/** Use zsh on macOS and Git Bash on Windows. Gates and helpers require POSIX shell syntax. CONDUCT_SHELL overrides the choice. */
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

/** Run a shell command with a timeout; combine stdout/stderr and retain the last keep characters. */
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
      out += `\n[conductor] exceeded limit ${timeoutSec} s — interrupted`;
      // On Windows, SIGTERM kills only Bash; children can retain pipes and prevent close, so terminate the process tree.
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

/** Remove parent-session environment variables so nested sessions do not inherit another session identity. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const keep = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']);
  for (const k of Object.keys(env)) if ((k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) && !keep.has(k)) delete env[k];
  // Disable interactive Git authentication so an unattended push fails promptly rather than hanging.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/** Remove directories already unregistered by Git but left behind because of locks or Windows path limits. Never call for a registered worktree. */
export async function removeDirHard(dir: string): Promise<boolean> {
  for (let i = 0; i < 3 && existsSync(dir); i++) {
    // Node handles Windows long paths and does not follow pnpm junctions when removing directories.
    // PowerShell 5.1 Remove-Item -Recurse fails on pnpm junctions (observed on 2026-10-03 with 35,000 files).
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch {
      /* Terminate processes holding locked files, then retry. */
      await killProcessesIn(dir);
    }
    if (existsSync(dir)) await new Promise((r) => setTimeout(r, 5000));
  }
  return !existsSync(dir);
}

/** Share a concurrency limit across current-wave and early-start tracks. */
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

/** Terminate processes with working directories or command lines inside dir. This releases server ports and file locks before removing worktrees. Use lsof -d cwd instead of the slow recursive lsof +D. */
export async function killProcessesIn(dir: string): Promise<number[]> {
  if (IS_WIN) return killProcessesInWin(dir);
  const mine = new Set([process.pid, process.ppid]);
  const pids = new Set<number>();
  // lsof resolves symlinks (/var to /private/var, /tmp to /private/tmp); compare both forms.
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    /* Directory no longer exists. */
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

/** Win32_Process does not expose cwd, so match command lines with either path separator. This may miss processes launched only by cd; also terminate listeners on track ports. */
async function killProcessesInWin(dir: string): Promise<number[]> {
  const mine = new Set([process.pid, process.ppid]);
  const back = dir.replace(/\//g, '\\');
  const fwd = dir.replace(/\\/g, '/');
  const ps =
    `$a='${back.replace(/'/g, "''")}'.ToLower(); $b='${fwd.replace(/'/g, "''")}'.ToLower(); ` +
    // Exclude this PowerShell process and its parent shell, whose command lines contain the search path.
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

/** Terminate listeners on the track port, supplementing Windows command-line matching. */
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

/** Return free GB on the volume containing dir. */
export async function freeGb(dir: string): Promise<number> {
  const r = await sh(`df -k ${q(dir)} | tail -1 | awk '{print $4}'`, '/', 30);
  const kb = Number(r.out.trim());
  return Number.isFinite(kb) ? kb / 1024 / 1024 : Infinity;
}

/** Serialize shared repository operations because Git holds locks during worktree and branch changes. */
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
