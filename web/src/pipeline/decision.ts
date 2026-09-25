// Etapa 07 · Decisión con rechazo y máquina de estados (sección 7.4 y tabla 6).
// Port 1:1 de core/mnemo/decision.py.
import type { DecisionConfig } from './config';

export type State = 'en_reposo' | 'observando' | 'afirmando' | 'absteniendose' | 'descartando';
export type Zone = 'match' | 'abstain' | 'reject';

export function classify(sMax: number, tauLow: number, tauHigh: number): Zone {
  if (sMax >= tauHigh) return 'match';
  if (sMax >= tauLow) return 'abstain';
  return 'reject';
}

export interface Observation {
  tMs: number;
  facePresent: boolean;
  usable: boolean;
  identityId?: string | null;
  sMax?: number;
  weakTemplate?: boolean;
}

export interface Announcement {
  kind: 'match' | 'abstain';
  identityId: string | null;
  sMax: number;
  hits: number;
  window: number;
  latencyMs: number;
}

export class DecisionEngine {
  state: State = 'en_reposo';
  private window: { zone: Zone; id: string | null; s: number }[] = [];
  private firstSeen: number | null = null;
  private lastSeen: number | null = null;
  private failed = 0;
  announced = false;

  constructor(public cfg: DecisionConfig) {}

  reset() {
    this.state = 'en_reposo';
    this.window = [];
    this.firstSeen = this.lastSeen = null;
    this.failed = 0;
    this.announced = false;
  }

  thresholds(weak: boolean): [number, number] {
    return [this.cfg.tauLow, this.cfg.tauHigh + (weak ? this.cfg.weakTemplatePenalty : 0)];
  }

  step(o: Observation): Announcement | null {
    const c = this.cfg;
    if (!o.facePresent) {
      if (this.lastSeen !== null && o.tMs - this.lastSeen > c.encounterGapMs) this.reset();
      else if (!this.announced) this.state = 'en_reposo';
      return null;
    }
    this.firstSeen ??= o.tMs;
    this.lastSeen = o.tMs;
    if (this.announced) return null; // RN-08: una frase por encuentro

    if (!o.usable) {
      if (++this.failed >= c.maxFailedFrames) {
        // CU-02 E1: tres cuadros inutilizables interrumpen el ciclo sin avisar.
        this.window = [];
        this.failed = 0;
        this.firstSeen = o.tMs;
      }
      return null;
    }
    this.failed = 0;

    const [lo, hi] = this.thresholds(!!o.weakTemplate);
    const s = o.sMax ?? -1;
    const zone = classify(s, lo, hi);
    this.window.push({ zone, id: zone === 'match' ? (o.identityId ?? null) : null, s });
    if (this.window.length > c.confirmWindow) this.window.shift();
    this.state = this.window.every((w) => w.zone === 'reject') ? 'descartando' : 'observando';

    const dwellOk = o.tMs - this.firstSeen >= c.dwellMs;
    if (this.window.length < c.confirmHits || !dwellOk) return null;

    const votes = new Map<string, number>();
    for (const w of this.window) if (w.zone === 'match' && w.id) votes.set(w.id, (votes.get(w.id) ?? 0) + 1);
    let best: string | null = null, hits = 0;
    for (const [id, n] of votes) if (n > hits) [best, hits] = [id, n];
    const latencyMs = o.tMs - this.firstSeen;
    if (best && hits >= c.confirmHits) {
      this.state = 'afirmando';
      this.announced = true;
      const sMax = Math.max(...this.window.filter((w) => w.id === best).map((w) => w.s));
      return { kind: 'match', identityId: best, sMax, hits, window: this.window.length, latencyMs };
    }
    const nonReject = this.window.filter((w) => w.zone !== 'reject').length;
    if (this.window.length === c.confirmWindow && nonReject >= c.confirmHits) {
      this.state = 'absteniendose';
      this.announced = true;
      const sMax = Math.max(...this.window.map((w) => w.s));
      return { kind: 'abstain', identityId: null, sMax, hits: nonReject, window: this.window.length, latencyMs };
    }
    return null;
  }
}
