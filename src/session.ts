import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { checkTool } from './policy.js';
import { cleanEnv } from './sh.js';
import type { Store } from './state.js';

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** Ktoś, kto odpowiada zamiast człowieka — nadzorca. */
export type Answerer = (qs: Question[], from: string) => Promise<Record<string, string>>;

export interface SessionSpec {
  /** klucz do logów i kosztów */
  name: string;
  costKey?: string | null;
  cwd: string;
  prompt: string;
  resume?: string;
  model?: string;
  /** katalogi, w których wolno pisać (worktree + writeRoots) */
  writeRoots: string[];
  extraDeny: string[];
  /** zamrożone ścieżki względem `worktree` */
  denyPaths?: string[];
  worktree?: string;
  answer?: Answerer;
  systemAppend?: string;
  /** zestaw narzędzi; domyślnie pełny Claude Code */
  tools?: string[];
  additionalDirectories?: string[];
  outputSchema?: Record<string, unknown>;
  settingSources?: Options['settingSources'];
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** limit zegara ściennego jednego podejścia sesji */
  timeoutMin?: number;
  /** wołane, gdy tylko sesja dostanie id — żeby stan miał je, zanim sesja się skończy (wznowienie po padnięciu) */
  onSessionId?: (id: string) => void;
  /** rzadkie zdarzenia środowiska (czekanie na reset limitu) — idą do powiadomień */
  onWait?: (msg: string) => void;
}

export interface SessionOutcome {
  sessionId?: string;
  ok: boolean;
  subtype: string;
  text: string;
  structured?: unknown;
  costUsd: number;
  denials: string[];
}

/** Przerwy między próbami po błędzie bez znanego resetu (sieć, 5xx): łącznie ~6 h, czyli dłużej niż okno 5-godzinne. */
const BACKOFF_MIN = [1, 5, 15, 30, 60, 60, 60, 60, 60];
const MAX_TIMEOUTS = 3;

/**
 * Ile czekać przed kolejną próbą. Gdy SDK zgłosiło odrzucenie z `resetsAt`, czekamy do resetu (+1 min),
 * zamiast strzelać co kilka minut w zamknięte okno. Zwraca ms.
 */
export function waitMs(attempt: number, resetsAt: number | undefined, now = Date.now()): number {
  if (resetsAt) {
    const at = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
    const ms = at - now + 60_000;
    if (ms > 0) return Math.min(ms, 12 * 3600_000);
  }
  return BACKOFF_MIN[Math.min(attempt, BACKOFF_MIN.length - 1)] * 60_000;
}

export async function runSession(spec: SessionSpec, store: Store): Promise<SessionOutcome> {
  let resume = spec.resume;
  let prompt = spec.prompt;
  let last: SessionOutcome | undefined;
  let cost = 0;
  let timeouts = 0;
  const denials: string[] = [];
  const limit: { resetsAt?: number; sessionId?: string } = {};

  for (let attempt = 0; attempt < BACKOFF_MIN.length + MAX_TIMEOUTS; attempt++) {
    limit.resetsAt = undefined;
    try {
      last = await once({ ...spec, resume, prompt }, store, denials, limit);
      cost += last.costUsd;
      if (last.ok || /error_max_(turns|budget)/.test(last.subtype) || last.structured !== undefined) break;
      store.log(`[${spec.name}] sesja zakończona błędem ${last.subtype}: ${last.text.slice(0, 200)}`);
    } catch (e: any) {
      store.log(`[${spec.name}] wyjątek sesji: ${String(e?.message ?? e).slice(0, 300)}`);
      last = { ok: false, subtype: 'exception', text: String(e?.message ?? e), costUsd: 0, denials, sessionId: last?.sessionId ?? resume };
    }
    if (last.sessionId) resume = last.sessionId;

    if (last.subtype === 'timeout') {
      if (++timeouts > MAX_TIMEOUTS) break;
      store.log(`[${spec.name}] przekroczony limit ${spec.timeoutMin} min — wznawiam od razu`);
      prompt =
        `Dyrygent przerwał sesję po ${spec.timeoutMin} min zegara. Najczęstsza przyczyna: polecenie na pierwszym planie, które się nie kończy ` +
        `(serwer dev, watch, commit czekający na hasło). Takie rzeczy uruchamiaj w tle z limitem czasu. Kontynuuj zadanie.`;
      continue;
    }
    const wait = waitMs(attempt, limit.resetsAt);
    const mins = Math.round(wait / 60000);
    store.log(`[${spec.name}] ponawiam za ${mins} min${limit.resetsAt ? ' (reset limitu subskrypcji)' : ''}`);
    if (limit.resetsAt && mins >= 20) spec.onWait?.(`limit subskrypcji — czekam ${mins} min do resetu, potem wznawiam sam`);
    await sleep(wait);
    if (resume) prompt = 'Sesja została przerwana (limit albo błąd sieci). Kontynuuj dokładnie od miejsca, w którym przerwałeś.';
  }
  return { ...last!, costUsd: cost, denials };
}

async function once(spec: SessionSpec, store: Store, denials: string[], limit: { resetsAt?: number; sessionId?: string }): Promise<SessionOutcome> {
  const abort = new AbortController();
  let timedOut = false;
  const timer = spec.timeoutMin
    ? setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, spec.timeoutMin * 60_000)
    : undefined;
  const timeout = (): SessionOutcome => ({ ok: false, subtype: 'timeout', text: 'przekroczony limit czasu', costUsd: 0, denials, sessionId: limit.sessionId ?? spec.resume });
  try {
    const r = await drive(spec, store, denials, limit, abort);
    return timedOut ? timeout() : r;
  } catch (e) {
    if (timedOut) return timeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function drive(spec: SessionSpec, store: Store, denials: string[], limit: { resetsAt?: number; sessionId?: string }, abort: AbortController): Promise<SessionOutcome> {
  const options: Options = {
    abortController: abort,
    cwd: spec.cwd,
    model: spec.model,
    resume: spec.resume,
    env: cleanEnv(),
    permissionMode: 'default',
    settingSources: spec.settingSources ?? ['project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemAppend },
    additionalDirectories: spec.additionalDirectories,
    maxTurns: spec.maxTurns,
    maxBudgetUsd: spec.maxBudgetUsd,
    stderr: (d) => store.sessionLog(spec.name, { stderr: d.slice(0, 2000) }),
    hooks: {
      // Hook odpala się przy KAŻDYM narzędziu, także tym, które ustawienia projektu dopuszczają bez pytania.
      PreToolUse: [
        {
          hooks: [
            async (input: any) => {
              const why = checkTool(input.tool_name, input.tool_input, spec.writeRoots, spec.extraDeny, spec.denyPaths, spec.worktree);
              if (!why) return {};
              denials.push(`${input.tool_name}: ${why}`);
              store.log(`[${spec.name}] ZAKAZ ${input.tool_name}: ${why}`);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: `Dyrygent: ${why}. Nikt nie odpowie na prośbę o wyjątek — znajdź inną drogę albo zapisz to jako otwartą sprawę w podsumowaniu.`,
                },
              };
            },
          ],
        },
      ],
    },
    canUseTool: async (tool, input) => {
      if (tool === 'AskUserQuestion' && spec.answer) {
        const qs = ((input as any).questions ?? []) as Question[];
        const answers = await spec.answer(qs, spec.name);
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      // Wszystko, co przeszło hook zakazów, jest dozwolone — człowieka nie ma.
      return { behavior: 'allow', updatedInput: input };
    },
  };
  if (spec.tools) options.tools = spec.tools;
  if (spec.outputSchema) options.outputFormat = { type: 'json_schema', schema: spec.outputSchema };

  let sessionId: string | undefined = spec.resume;
  let text = '';
  for await (const msg of query({ prompt: spec.prompt, options }) as AsyncIterable<SDKMessage>) {
    const m: any = msg;
    if (m.session_id && m.session_id !== sessionId) {
      sessionId = limit.sessionId = m.session_id;
      spec.onSessionId?.(m.session_id);
    }
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text') store.sessionLog(spec.name, { t: 'text', text: c.text });
        if (c.type === 'tool_use') store.sessionLog(spec.name, { t: 'tool', name: c.name, input: truncate(c.input) });
      }
    } else if (m.type === 'rate_limit_event') {
      store.sessionLog(spec.name, { t: 'rate_limit', info: m.rate_limit_info });
      if (m.rate_limit_info?.status === 'rejected') limit.resetsAt = m.rate_limit_info.resetsAt;
    } else if (m.type === 'result') {
      text = m.result ?? (m.errors ?? []).join('\n');
      store.sessionLog(spec.name, { t: 'result', subtype: m.subtype, cost: m.total_cost_usd, text: text.slice(0, 4000) });
      store.addCost(spec.costKey ?? null, m.total_cost_usd ?? 0);
      return {
        sessionId,
        ok: m.subtype === 'success' && !m.is_error,
        subtype: m.subtype,
        text,
        structured: m.structured_output,
        costUsd: m.total_cost_usd ?? 0,
        denials,
      };
    }
  }
  return { sessionId, ok: false, subtype: 'no_result', text, costUsd: 0, denials };
}

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s && s.length > 1500 ? s.slice(0, 1500) + '…' : v;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
