import { resolve, sep } from 'node:path';

/** Deny irreversible actions and conductor-owned operations such as pushes, integration and cleanup. Return a reason so the session can choose another approach. */
const BUILTIN: [RegExp, string][] = [
  [/\bgit\s+push\b/, 'only the conductor may push after a wave passes'],
  [/\bgit\s+reset\s+(?:[^|;&]*\s)?--hard\b/, 'reset --hard can delete other work; use reset --mixed or a new commit'],
  [/\bgit\s+clean\s+(?:[^|;&]*\s)?-[a-zA-Z]*f/, 'git clean -f deletes untracked files'],
  [/\bgit\s+add\s+(?:[^|;&]*\s)?(?:-A\b|--all\b|\.(?:\s|$|;|&|\|))/, 'stage explicit paths (git add <file>), not -A/--all/.'],
  [/\bgit\s+checkout\s+(?:[^|;&]*\s)?(?:--\s+)?\.(?:\s|$|;|&|\|)/, 'checkout . deletes uncommitted changes'],
  [/\bgit\s+restore\s+(?:[^|;&]*\s)?\.(?:\s|$|;|&|\|)/, 'restore . deletes uncommitted changes'],
  [/\bgit\s+branch\s+(?:[^|;&]*\s)?-(?:[dD]|-delete)\b/, 'the conductor deletes branches after integration'],
  [/\bgit\s+worktree\s+(?:remove|prune)\b/, 'the conductor cleans up worktrees'],
  [/\bgit\s+(?:rebase|filter-branch|filter-repo)\b/, 'history rewriting is forbidden'],
  [/\bgit\s+commit\s+(?:[^|;&]*\s)?--amend\b/, 'do not amend commits; add a new commit'],
  [/\bgit\s+(?:checkout|switch)\s+(?:[^|;&]*\s)?(?:main|master)(?=\s|$|;|&|\|)/, 'stay on your track branch'],
  [/\bgit\s+merge(?![-\w])[^|;&]*\s(?:origin\/)?(?:main|master)(?=\s|$|;|&|\|)/, 'the conductor integrates into the main branch'],
  [/\bgit\s+stash\b(?!\s+(?:list|show)\b)/, 'git stash is shared across worktrees; commit or leave changes in the worktree'],
  [/\bgh\s+(?:repo\s+(?:delete|create|edit)|release|pr\s+merge|secret)\b/, 'the conductor handles GitHub operations'],
  [/\bsudo\b/, 'sudo is forbidden'],
  [/\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:[^|;&]*\s)?(?:\/|~|\$HOME|\.\.)(?:\s|\/?$|;|&|\|)/, 'rm -r on /, ~, $HOME or .. is forbidden'],
  [/\bcaffeinate\b|\bshutdown\b|\breboot\b|\bkillall\b|\bpkill\s+-9\b/, 'system command is forbidden'],
];

/** Strip Git global options before matching restrictions, so git -C <path> push and git -c k=v reset --hard cannot bypass subcommand checks. */
export function normalizeGit(cmd: string): string {
  const opt = String.raw`(?:(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|exec-path)(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+))|--no-pager|--paginate|-p|-P|--bare|--no-replace-objects|--literal-pathspecs)`;
  return cmd.replace(new RegExp(String.raw`\bgit((?:\s+${opt})+)(?=\s)`, 'g'), 'git');
}

export function checkBash(raw: string, extra: string[] = []): string | null {
  const cmd = normalizeGit(raw);
  for (const [re, why] of BUILTIN) if (re.test(cmd)) return why;
  for (const p of extra) if (new RegExp(p).test(cmd)) return `manifest restriction: /${p}/ (publishing and irreversible operations are outside session scope)`;
  return null;
}

/** Allow file writes only inside permitted roots: the track worktree and writeRoots. */
export function checkWrite(path: string, roots: string[]): string | null {
  const p = resolve(path);
  const ok = roots.some((r) => {
    const root = resolve(r);
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
  return ok ? null : `write outside allowed directories (${roots.join(', ')}): ${p}`;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Match frozen paths relative to the worktree root, including path fragments. */
export function checkDenyPath(path: string, worktree: string | undefined, deny: string[]): string | null {
  if (!worktree || deny.length === 0) return null;
  const p = resolve(path);
  const root = resolve(worktree) + sep;
  if (!p.startsWith(root)) return null;
  const rel = p.slice(root.length);
  const hit = deny.find((d) => rel === d.replace(/\/$/, '') || rel.startsWith(d.endsWith('/') ? d : d + '/') || ('/' + rel).includes('/' + d));
  return hit ? `path protected by the plan (${hit}): ${rel}` : null;
}

/** Evaluate each tool call from the PreToolUse hook. */
export function checkTool(tool: string, input: any, roots: string[], extra: string[], denyPaths: string[] = [], worktree?: string): string | null {
  if (tool === 'Bash' && typeof input?.command === 'string') return checkBash(input.command, extra);
  if (WRITE_TOOLS.has(tool)) {
    const f = input?.file_path ?? input?.notebook_path;
    if (typeof f === 'string') return checkWrite(f, roots) ?? checkDenyPath(f, worktree, denyPaths);
  }
  return null;
}
