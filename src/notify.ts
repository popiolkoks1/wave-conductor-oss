import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, q } from './sh.js';

export type NotifyKind = 'start' | 'wave' | 'done' | 'stopped' | 'problem' | 'heartbeat';

export interface NotifyConfig {
  /** Centrum powiadomień macOS (osascript) */
  macos: boolean;
  /** temat ntfy.sh — powiadomienie na telefon bez żadnego konta (https://ntfy.sh/<temat>) */
  ntfy?: string;
  /** dowolne polecenie; dostaje treść w $CONDUCTOR_MESSAGE i rodzaj w $CONDUCTOR_KIND */
  command?: string;
  /** jeśli od ostatniego powiadomienia minęło tyle godzin, a fala wciąż trwa — krótki znak życia; 0 = wyłączone */
  heartbeatHours: number;
}

export const DEFAULT_NOTIFY: NotifyConfig = { macos: true, heartbeatHours: 6 };

/**
 * Powiadomienia są RZADKIE z założenia: start, koniec każdej fali, koniec przebiegu,
 * problem środowiska (dysk, main zajęty, limit), rzadki znak życia. Nic per tor, nic per decyzja.
 * Każde trafia też do notify.jsonl — z tego pliku czyta sesja Claude, która przebieg uruchomiła.
 */
export class Notifier {
  private last = Date.now();
  constructor(private cfg: NotifyConfig, private runDir: string, private title: string) {}

  async send(kind: NotifyKind, message: string) {
    this.last = Date.now();
    const msg = message.replace(/\s+/g, ' ').trim().slice(0, 190);
    appendFileSync(join(this.runDir, 'notify.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, message: msg }) + '\n');
    const jobs: Promise<unknown>[] = [];
    if (this.cfg.macos && process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(this.title)}${kind === 'done' || kind === 'stopped' || kind === 'problem' ? ' sound name "Glass"' : ''}`;
      jobs.push(sh(`osascript -e ${q(script)}`, this.runDir, 20));
    }
    if (this.cfg.ntfy) {
      const prio = kind === 'done' || kind === 'stopped' || kind === 'problem' ? 'high' : 'default';
      jobs.push(sh(`curl -s -m 15 -H ${q(`Title: ${this.title}`)} -H 'Priority: ${prio}' -d ${q(msg)} ${q(`https://ntfy.sh/${this.cfg.ntfy}`)}`, this.runDir, 20));
    }
    if (this.cfg.command) {
      jobs.push(sh(`CONDUCTOR_KIND=${q(kind)} CONDUCTOR_MESSAGE=${q(msg)} ${this.cfg.command}`, this.runDir, 30));
    }
    await Promise.allSettled(jobs);
  }

  /** Wołane okresowo; wysyła znak życia tylko, gdy od dawna było cicho. */
  async heartbeat(status: () => string) {
    if (!this.cfg.heartbeatHours) return;
    if (Date.now() - this.last < this.cfg.heartbeatHours * 3600_000) return;
    await this.send('heartbeat', status());
  }
}
