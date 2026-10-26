import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Review } from './manifest.js';
import { cleanEnv, IS_WIN, killPort, killProcessesIn, sh, SHELL } from './sh.js';

export interface Shots {
  dir: string;
  pngs: string[];
  log: string;
}

const listPngs = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true } as any)
        .map(String)
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .sort()
        .map((f) => join(dir, f))
    : [];

/**
 * Pokaz projektu robiony przez DYRYGENTA, nie przez sesję toru: serwer w worktree w tle, czekanie na 200,
 * polecenie zrzutów z manifestu, sprzątanie serwera. Tor nie ma wpływu na to, co zobaczy recenzent.
 */
export async function takeShowcase(r: Review, worktree: string, port: number, out: string): Promise<Shots> {
  mkdirSync(out, { recursive: true });
  await killPort(port);
  const server = spawn(SHELL, ['-lc', r.serve.replaceAll('{port}', String(port))], { cwd: worktree, env: cleanEnv(), stdio: 'ignore', detached: !IS_WIN });
  const url = `http://127.0.0.1:${port}`;
  let log = '';
  try {
    const ready = `${url}${r.ready ?? '/'}`;
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      const c = await sh(`curl -s -o /dev/null -w '%{http_code}' ${JSON.stringify(ready)}`, '/', 30);
      up = c.out.trim() === '200';
      if (!up) await new Promise((res) => setTimeout(res, 2000));
    }
    if (!up) return { dir: out, pngs: [], log: `serwer pokazu nie wstał w 3 min (${ready})` };
    // Ścieżka w poleceniu bash: ukośniki do przodu i w cudzysłowie — `\` z Windowsa bash zjada („C:Users…”, zmierzone 2026-10-03).
    const cmd = r.showcase.replaceAll('{url}', url).replaceAll('{out}', JSON.stringify(out.replace(/\\/g, '/')));
    const res = await sh(cmd, worktree, 1800, 8000);
    log = res.out;
  } finally {
    await killPort(port);
    if (!IS_WIN && server.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* już nie żyje */
      }
    }
    await killProcessesIn(worktree);
  }
  return { dir: out, pngs: listPngs(out), log };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Strona „przed / po”: te same nazwy plików obok siebie, recenzja na górze. Ścieżki względne, działa z dysku. */
export function writeShowcasePage(page: string, title: string, after: Shots, before: Shots | undefined, verdict: { stars: number; verdict: string; summary: string; issues: string[] } | undefined): string {
  const dir = join(page, '..');
  const rel = (p: string) => relative(dir, p).replace(/\\/g, '/');
  const prevByName = new Map((before?.pngs ?? []).map((p) => [basename(p), p]));
  const rows = after.pngs
    .map((p) => {
      const prev = prevByName.get(basename(p));
      return `<section><h3>${esc(basename(p, '.png'))}</h3><div class="pair">${prev ? `<figure><img src="${rel(prev)}" loading="lazy"><figcaption>przed</figcaption></figure>` : ''}<figure><img src="${rel(p)}" loading="lazy"><figcaption>${prev ? 'po' : 'teraz'}</figcaption></figure></div></section>`;
    })
    .join('\n');
  const head = verdict
    ? `<p class="v">Recenzent: <b>${'★'.repeat(verdict.stars)}${'☆'.repeat(Math.max(0, 3 - verdict.stars))}</b> (${esc(verdict.verdict)}) — ${esc(verdict.summary)}</p>${verdict.issues.length ? `<ul>${verdict.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`
    : '';
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;margin:16px;background:Canvas;color:CanvasText}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}img{width:100%;border:1px solid #8884;border-radius:6px}
figure{margin:0}figcaption{opacity:.7;font-size:13px}h3{margin:24px 0 8px}.v{font-size:17px}</style>
<h1>${esc(title)}</h1>${head}${after.pngs.length ? '' : `<p>Brak zrzutów. Log: <pre>${esc(after.log.slice(-3000))}</pre></p>`}
${rows}`;
  writeFileSync(page, html);
  return page;
}
