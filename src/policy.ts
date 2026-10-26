import { resolve, sep } from 'node:path';

/**
 * Twarde zakazy dla sesji. Zasada: sesja nie robi niczego nieodwracalnego ani niczego,
 * co należy do dyrygenta (push, scalanie do gałęzi głównej, kasowanie gałęzi/worktree).
 * Nie pytamy człowieka — odmawiamy z komunikatem, a sesja szuka innej drogi.
 */
const BUILTIN: [RegExp, string][] = [
  [/\bgit\s+push\b/, 'push robi wyłącznie dyrygent po zielonej fali'],
  [/\bgit\s+reset\s+(?:[^|;&]*\s)?--hard\b/, 'reset --hard kasuje cudzą pracę; użyj reset --mixed albo nowego commita'],
  [/\bgit\s+clean\s+(?:[^|;&]*\s)?-[a-zA-Z]*f/, 'git clean -f kasuje nieśledzone pliki'],
  [/\bgit\s+add\s+(?:[^|;&]*\s)?(?:-A\b|--all\b|\.(?:\s|$|;|&|\|))/, 'staguj ścieżki JAWNIE (git add <plik>…), nie -A/--all/.'],
  [/\bgit\s+checkout\s+(?:[^|;&]*\s)?(?:--\s+)?\.(?:\s|$|;|&|\|)/, 'checkout . kasuje niezacommitowane zmiany'],
  [/\bgit\s+restore\s+(?:[^|;&]*\s)?\.(?:\s|$|;|&|\|)/, 'restore . kasuje niezacommitowane zmiany'],
  [/\bgit\s+branch\s+(?:[^|;&]*\s)?-(?:[dD]|-delete)\b/, 'gałęzie kasuje dyrygent po scaleniu'],
  [/\bgit\s+worktree\s+(?:remove|prune)\b/, 'worktree sprząta dyrygent'],
  [/\bgit\s+(?:rebase|filter-branch|filter-repo)\b/, 'przepisywanie historii jest zakazane'],
  [/\bgit\s+commit\s+(?:[^|;&]*\s)?--amend\b/, 'nie poprawiaj commitów — dodaj nowy'],
  [/\bgit\s+(?:checkout|switch)\s+(?:[^|;&]*\s)?(?:main|master)(?=\s|$|;|&|\|)/, 'zostań na gałęzi swojego toru'],
  [/\bgit\s+merge(?![-\w])[^|;&]*\s(?:origin\/)?(?:main|master)(?=\s|$|;|&|\|)/, 'do gałęzi głównej scala dyrygent'],
  [/\bgit\s+stash\b(?!\s+(?:list|show)\b)/, 'git stash jest WSPÓLNY dla wszystkich worktree — commituj albo zostaw zmiany w drzewie'],
  [/\bgh\s+(?:repo\s+(?:delete|create|edit)|release|pr\s+merge|secret)\b/, 'operacje na GitHubie należą do dyrygenta'],
  [/\bsudo\b/, 'sudo jest zakazane'],
  [/\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:[^|;&]*\s)?(?:\/|~|\$HOME|\.\.)(?:\s|\/?$|;|&|\|)/, 'rm -r na /, ~, $HOME albo .. jest zakazane'],
  [/\bcaffeinate\b|\bshutdown\b|\breboot\b|\bkillall\b|\bpkill\s+-9\b/, 'polecenie systemowe zakazane'],
];

/**
 * `git -C "<ścieżka>" push`, `git -c k=v reset --hard`, `git --git-dir=… …` — opcje globalne przed podpoleceniem
 * omijały każdą regułę `git\s+<podpolecenie>`.
 * Przed dopasowaniem zdejmujemy je, zostawiając `git <podpolecenie> …`.
 */
export function normalizeGit(cmd: string): string {
  const opt = String.raw`(?:(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|exec-path)(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+))|--no-pager|--paginate|-p|-P|--bare|--no-replace-objects|--literal-pathspecs)`;
  return cmd.replace(new RegExp(String.raw`\bgit((?:\s+${opt})+)(?=\s)`, 'g'), 'git');
}

export function checkBash(raw: string, extra: string[] = []): string | null {
  const cmd = normalizeGit(raw);
  for (const [re, why] of BUILTIN) if (re.test(cmd)) return why;
  for (const p of extra) if (new RegExp(p).test(cmd)) return `zakaz z manifestu: /${p}/ (publikacja i operacje nieodwracalne są poza sesjami)`;
  return null;
}

/** Pisanie plików tylko w obrębie dozwolonych korzeni (worktree toru + writeRoots). */
export function checkWrite(path: string, roots: string[]): string | null {
  const p = resolve(path);
  const ok = roots.some((r) => {
    const root = resolve(r);
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
  return ok ? null : `zapis poza dozwolonymi katalogami (${roots.join(', ')}): ${p}`;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Zakazane ścieżki względem korzenia worktree (np. `math/`, `src/types/`) — dopasowanie po fragmencie ścieżki. */
export function checkDenyPath(path: string, worktree: string | undefined, deny: string[]): string | null {
  if (!worktree || deny.length === 0) return null;
  const p = resolve(path);
  const root = resolve(worktree) + sep;
  if (!p.startsWith(root)) return null;
  const rel = p.slice(root.length);
  const hit = deny.find((d) => rel === d.replace(/\/$/, '') || rel.startsWith(d.endsWith('/') ? d : d + '/') || ('/' + rel).includes('/' + d));
  return hit ? `ścieżka zamrożona przez plan (${hit}): ${rel}` : null;
}

/** Decyzja dla dowolnego narzędzia — używana przez hook PreToolUse, który odpala się przy każdym wywołaniu. */
export function checkTool(tool: string, input: any, roots: string[], extra: string[], denyPaths: string[] = [], worktree?: string): string | null {
  if (tool === 'Bash' && typeof input?.command === 'string') return checkBash(input.command, extra);
  if (WRITE_TOOLS.has(tool)) {
    const f = input?.file_path ?? input?.notebook_path;
    if (typeof f === 'string') return checkWrite(f, roots) ?? checkDenyPath(f, worktree, denyPaths);
  }
  return null;
}
