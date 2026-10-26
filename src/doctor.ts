import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { contextBundle, mergePromptOf, trackPrompt, type Manifest } from './manifest.js';
import { Notifier } from './notify.js';
import { cleanEnv, freeGb, sh } from './sh.js';

type Level = 'ok' | 'warn' | 'fail';
interface Check {
  level: Level;
  what: string;
  fix?: string;
}

/**
 * Wszystko, co potrafi wywrócić wielogodzinny przebieg, sprawdzane PRZED startem —
 * żeby porażka była po 30 s, a nie po 5 godzinach.
 */
export async function doctor(m: Manifest, opts: { auth: boolean; testNotify: boolean; running: boolean; print?: (s: string) => void }): Promise<boolean> {
  const out: Check[] = [];
  const add = (level: Level, what: string, fix?: string) => out.push({ level, what, fix });

  // plan
  try {
    contextBundle(m);
    for (const w of m.waves) {
      mergePromptOf(m, w);
      for (const t of w.tracks) trackPrompt(m, t);
    }
    add('ok', `plan: ${m.waves.length} fal, ${m.waves.reduce((n, w) => n + w.tracks.length, 0)} torów, wszystkie prompty czytelne`);
  } catch (e: any) {
    add('fail', `plan: ${e.message}`, 'popraw ścieżki promptFile/context w manifeście');
  }

  // repo
  const g = (a: string) => sh(`git ${a}`, m.repo, 60);
  if (!existsSync(m.repo)) add('fail', `repo ${m.repo} nie istnieje`);
  else {
    const head = (await g('rev-parse --abbrev-ref HEAD')).out.trim();
    if (head !== m.mainBranch) add('fail', `katalog repo stoi na „${head}”, a dyrygent przewija ${m.mainBranch} w tym katalogu`, `git -C ${m.repo} switch ${m.mainBranch}`);
    else add('ok', `repo na ${m.mainBranch}`);
    const dirty = (await g('status --porcelain --untracked-files=no')).out.trim();
    if (dirty) add('warn', `repo ma niezacommitowane zmiany w śledzonych plikach (${dirty.split('\n').length}) — mogą zablokować przewinięcie ${m.mainBranch}`, 'zacommituj albo odłóż je przed startem');
    const wts = (await g('worktree list --porcelain')).out.split('\n').filter((l) => l.startsWith('worktree ')).length - 1;
    if (wts > 0) add('warn', `repo ma ${wts} innych worktree — nie przeszkadzają dyrygentowi, ale plan może wymagać ich braku`);
    for (const k of ['user.name', 'user.email']) if ((await g(`config --get ${k}`)).code !== 0) add('fail', `git ${k} nie jest ustawione — commity sesji się nie udadzą`);
    const sign = (await g('config --get commit.gpgsign')).out.trim() === 'true';
    const fmt = (await g('config --get gpg.format')).out.trim();
    if (sign && fmt === 'ssh') {
      const agent = await sh('ssh-add -l', m.repo, 20);
      if (agent.code !== 0) add('fail', 'commity są podpisywane kluczem SSH, a ssh-agent nie ma klucza — każdy commit sesji ZAWIŚNIE na pytaniu o hasło', 'ssh-add --apple-use-keychain ~/.ssh/<klucz>');
      else add('ok', 'podpisywanie SSH: klucz w agencie');
    } else if (sign) add('warn', `commity podpisywane (${fmt || 'gpg'}) — upewnij się, że podpis nie pyta o hasło`);
  }

  // miejsce, katalogi
  try {
    mkdirSync(m.worktreeRoot, { recursive: true });
    mkdirSync(m.stateDir, { recursive: true });
    accessSync(m.worktreeRoot, constants.W_OK);
    const gb = await freeGb(m.worktreeRoot);
    // rozmiar plików śledzonych (to, co dostaje nowy worktree) + ~0,6 GB na zależności; `du` po repo z node_modules trwał minuty
    const tracked = await sh(`git ls-files -z | xargs -0 stat -c %s 2>/dev/null | awk '{s+=$1} END {print s+0}'`, m.repo, 120);
    const repoGb = (Number(tracked.out.trim()) || 0) / 1024 ** 3 + 0.6;
    const need = repoGb * (Math.min(m.maxParallel, maxUnits(m)) + 1) + m.minFreeGb;
    if (gb < m.minFreeGb) add('fail', `wolne ${gb.toFixed(1)} GB < minFreeGb ${m.minFreeGb}`);
    else if (gb < need) add('warn', `wolne ${gb.toFixed(1)} GB, a ${Math.min(m.maxParallel, maxUnits(m))} worktree + integracja po ~${repoGb.toFixed(1)} GB potrzebują ~${need.toFixed(0)} GB — dyrygent będzie czekał na miejsce`, 'zmniejsz maxParallel albo zwolnij miejsce');
    else add('ok', `dysk: ${gb.toFixed(0)} GB wolnego (potrzeba ~${need.toFixed(0)})`);
  } catch (e: any) {
    add('fail', `katalogi robocze: ${e.message}`);
  }

  // narzędzia — brak wychodzi dopiero po godzinie, w sesji toru albo w bramce
  const missing: string[] = [];
  for (const tool of m.requires) if ((await sh(`command -v ${tool}`, '/', 20)).code !== 0) missing.push(tool);
  if (m.requires.length) missing.length ? add('fail', `brak na PATH: ${missing.join(', ')}`, 'zainstaluj albo dopisz katalog do PATH przed `conduct start` (sesje dziedziczą środowisko)') : add('ok', `narzędzia: ${m.requires.join(', ')}`);

  if (process.platform === 'win32') {
    const lp = (await sh('git config --get core.longpaths', m.repo, 20)).out.trim();
    if (lp !== 'true') add('warn', 'git core.longpaths wyłączone — sprzątanie worktree z node_modules padnie na ścieżkach > 260 znaków', 'git config --global core.longpaths true');
  }
  if (m.policy.push) {
    const ls = await sh('git ls-remote --exit-code origin HEAD', m.repo, 45);
    if (ls.code !== 0) add('warn', 'push włączony, a `git ls-remote origin` nie przechodzi bez logowania — push gałęzi się nie uda (praca zostanie lokalnie)', 'zaloguj gita (credential manager / gh auth) albo ustaw policy.push: false');
    else add('ok', 'origin dostępny bez interakcji (push zadziała)');
  }

  // zasilanie i uśpienie
  if (process.platform === 'darwin') {
    const batt = (await sh('pmset -g batt', '/', 20)).out;
    if (!/AC Power/.test(batt)) add('warn', 'Mac na baterii — caffeinate nie utrzyma go przy zamkniętej klapie; przebieg stanie do wybudzenia', 'podłącz zasilanie; nie zamykaj klapy bez zewnętrznego monitora');
    else add('ok', 'zasilanie sieciowe (nie zamykaj klapy bez zewnętrznego monitora — to usypia mimo caffeinate)');
  }

  if (opts.running) add('fail', 'przebieg dla tego manifestu już trwa', 'conduct status / conduct stop');

  // uwierzytelnienie modelu
  if (opts.auth) {
    try {
      let ok = false;
      let err = '';
      for await (const msg of query({
        prompt: 'Odpowiedz jednym słowem: OK',
        options: { model: m.models.supervisor, tools: [], maxTurns: 1, settingSources: [], env: cleanEnv(), cwd: m.planDir },
      }) as AsyncIterable<any>) {
        if (msg.type === 'result') {
          ok = msg.subtype === 'success' && !msg.is_error;
          err = msg.result ?? '';
        }
        if (msg.type === 'rate_limit_event' && msg.rate_limit_info?.status === 'rejected') {
          const at = msg.rate_limit_info.resetsAt;
          add('warn', `limit subskrypcji wyczerpany${at ? ` do ${new Date(at < 1e12 ? at * 1000 : at).toLocaleTimeString('pl-PL')}` : ''} — przebieg zacznie od czekania`);
        }
      }
      ok ? add('ok', `model ${m.models.supervisor ?? '(domyślny)'} odpowiada`) : add('fail', `model nie odpowiedział: ${err.slice(0, 200)}`, 'zaloguj Claude Code albo ustaw ANTHROPIC_API_KEY');
    } catch (e: any) {
      add('fail', `uwierzytelnienie: ${String(e.message).slice(0, 200)}`, 'zaloguj Claude Code albo ustaw ANTHROPIC_API_KEY');
    }
  }

  // powiadomienia
  const chans = [m.notify.macos && 'macOS', m.notify.ntfy && `ntfy:${m.notify.ntfy}`, m.notify.command && 'polecenie'].filter(Boolean);
  add(chans.length ? 'ok' : 'warn', `powiadomienia: ${chans.join(', ') || 'brak kanału (tylko notify.jsonl)'}${m.notify.heartbeatHours ? `, znak życia co ${m.notify.heartbeatHours} h ciszy` : ''}`);
  if (opts.testNotify) await new Notifier(m.notify, m.stateDir, `Dyrygent: ${m.name}`).send('start', 'test powiadomienia — jeśli to widzisz, kanał działa');

  const icon = { ok: '✓', warn: '!', fail: '✗' };
  const print = opts.print ?? console.log;
  for (const c of out) print(`${icon[c.level]} ${c.what}${c.fix ? `\n    → ${c.fix}` : ''}`);
  return !out.some((c) => c.level === 'fail');
}

const maxUnits = (m: Manifest) => Math.max(...m.waves.map((w) => w.tracks.reduce((n, t) => n + (t.variants?.length ?? 1), 0)));
