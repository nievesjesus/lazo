// Stage 07 · Decision with rejection and state machine.
// 1:1 port of core/mnemo/decision.py.
//
// Encounter = for as long as the same person stays in front of the camera. An encounter produces at
// most one phrase. It ends when there is no face for `encounterGapMs` or when the person changes:
// the embedding of the current frame stops resembling that of the face already announced (the "anchor")
// for `changeFrames` consecutive frames. A change is detected by face continuity, not by identity,
// so it also works between two strangers.
import type { DecisionConfig } from './config';

export type State = 'en_reposo' | 'observando' | 'afirmando' | 'absteniendose' | 'descartando';
export type Zone = 'match' | 'abstain' | 'reject';
export type Reason = 'encuentro' | 'cambio' | 'pedido';

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
  /** Normalized embedding of the frame's face: only used in memory, to detect a change of person. */
  embedding?: Float32Array | null;
}

export interface Announcement {
  /** match ⇒ name the person · abstain ⇒ «not sure» · unknown ⇒ nobody from the circle */
  kind: 'match' | 'abstain' | 'unknown';
  reason: Reason;
  identityId: string | null;
  sMax: number;
  hits: number;
  window: number;
  latencyMs: number;
}

const cos = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export class DecisionEngine {
  state: State = 'en_reposo';
  announced = false;
  private window: { zone: Zone; id: string | null; s: number }[] = [];
  private firstSeen: number | null = null;
  private lastSeen: number | null = null;
  private failed = 0;
  private anchor: Float32Array | null = null;
  private changeCount = 0;
  private skipDwell = false;
  private reason: Reason = 'encuentro';
  private silent = false; // new encounter caused by a change, with automatic announcements turned off

  constructor(public cfg: DecisionConfig) {}

  reset() {
    this.state = 'en_reposo';
    this.window = [];
    this.firstSeen = this.lastSeen = null;
    this.failed = 0;
    this.announced = false;
    this.anchor = null;
    this.changeCount = 0;
    this.skipDwell = false;
    this.reason = 'encuentro';
    this.silent = false;
  }

  /** «¿Quién es?»: immediate new encounter, with no minimum dwell time, that always answers. */
  request() {
    this.reset();
    this.skipDwell = true;
    this.reason = 'pedido';
  }

  thresholds(weak: boolean): [number, number] {
    return [this.cfg.tauLow, this.cfg.tauHigh + (weak ? this.cfg.weakTemplatePenalty : 0)];
  }

  private newEncounter(tMs: number) {
    this.window = [];
    this.failed = 0;
    this.firstSeen = tMs;
    this.announced = false;
    this.anchor = null;
    this.changeCount = 0;
    this.skipDwell = true; // the person is already in front of the wearer: no need to wait for the dwell time
    this.reason = 'cambio';
    this.silent = !this.cfg.announceOnChange;
    this.state = 'observando';
  }

  /** Tracks the announced face; returns true if the person changed. */
  private tracksChange(emb: Float32Array): boolean {
    if (!this.anchor) {
      this.anchor = emb.slice();
      return false;
    }
    if (cos(this.anchor, emb) >= this.cfg.changeThreshold) {
      this.changeCount = 0;
      // Slow update of the anchor to follow changes in pose and lighting.
      let n = 0;
      for (let i = 0; i < emb.length; i++) {
        this.anchor[i] = 0.85 * this.anchor[i] + 0.15 * emb[i];
        n += this.anchor[i] * this.anchor[i];
      }
      n = Math.sqrt(n);
      for (let i = 0; i < emb.length; i++) this.anchor[i] /= n;
      return false;
    }
    return ++this.changeCount >= this.cfg.changeFrames;
  }

  private emit(a: Omit<Announcement, 'reason'>, o: Observation): Announcement | null {
    this.announced = true;
    this.anchor = o.embedding ? o.embedding.slice() : null;
    this.changeCount = 0;
    const quiet = this.reason !== 'pedido' && (this.silent || (a.kind === 'unknown' && !this.cfg.announceUnknown));
    return quiet ? null : { ...a, reason: this.reason };
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

    if (this.announced) {
      // Stay silent while it is the same person; a change opens a new encounter.
      if (o.usable && o.embedding && this.tracksChange(o.embedding)) this.newEncounter(o.tMs);
      else return null;
    }

    if (!o.usable) {
      if (++this.failed >= c.maxFailedFrames) {
        // Three unusable frames in a row interrupt the cycle without announcing anything.
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

    const dwellOk = this.skipDwell || o.tMs - this.firstSeen >= c.dwellMs;
    if (this.window.length < c.confirmHits || !dwellOk) return null;

    const votes = new Map<string, number>();
    for (const w of this.window) if (w.zone === 'match' && w.id) votes.set(w.id, (votes.get(w.id) ?? 0) + 1);
    let best: string | null = null, hits = 0;
    for (const [id, n] of votes) if (n > hits) [best, hits] = [id, n];
    const latencyMs = o.tMs - this.firstSeen;
    const base = { window: this.window.length, latencyMs };
    if (best && hits >= c.confirmHits) {
      this.state = 'afirmando';
      const sMax = Math.max(...this.window.filter((w) => w.id === best).map((w) => w.s));
      return this.emit({ kind: 'match', identityId: best, sMax, hits, ...base }, o);
    }
    if (this.window.length < c.confirmWindow) return null;
    const rejects = this.window.filter((w) => w.zone === 'reject').length;
    const sMax = Math.max(...this.window.map((w) => w.s));
    if (this.window.length - rejects >= c.confirmHits) {
      this.state = 'absteniendose';
      return this.emit({ kind: 'abstain', identityId: null, sMax, hits: this.window.length - rejects, ...base }, o);
    }
    if (rejects >= c.confirmHits) {
      // Nobody from the circle. Nothing biometric is recorded: it only decides whether to say so.
      this.state = 'descartando';
      return this.emit({ kind: 'unknown', identityId: null, sMax, hits: rejects, ...base }, o);
    }
    return null;
  }
}
