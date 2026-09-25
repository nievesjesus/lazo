// Etapa 07 · Decisión con rechazo y máquina de estados (sección 7.4 y tabla 6).
// Port 1:1 de core/mnemo/decision.py.
//
// Encuentro = mientras la misma persona siga frente a la cámara. Un encuentro produce a lo sumo una
// frase (RN-08). Termina cuando no hay rostro durante `encounterGapMs` o cuando cambia la persona:
// el embedding del cuadro actual deja de parecerse al del rostro ya anunciado (el «ancla") durante
// `changeFrames` cuadros seguidos. El cambio se detecta por continuidad del rostro, no por identidad,
// así que también funciona entre dos desconocidos.
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
  /** Embedding normalizado del rostro del cuadro: sólo se usa en memoria para detectar el cambio de persona. */
  embedding?: Float32Array | null;
}

export interface Announcement {
  /** match ⇒ nombrar · abstain ⇒ «no estoy seguro» · unknown ⇒ nadie del círculo */
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
  private silent = false; // encuentro nuevo por cambio con el aviso automático desactivado

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

  /** «¿Quién es?»: nuevo encuentro inmediato, sin permanencia mínima, que siempre responde. */
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
    this.skipDwell = true; // la persona ya está frente al portador: no se espera la permanencia
    this.reason = 'cambio';
    this.silent = !this.cfg.announceOnChange;
    this.state = 'observando';
  }

  /** Sigue al rostro anunciado; devuelve true si la persona cambió. */
  private tracksChange(emb: Float32Array): boolean {
    if (!this.anchor) {
      this.anchor = emb.slice();
      return false;
    }
    if (cos(this.anchor, emb) >= this.cfg.changeThreshold) {
      this.changeCount = 0;
      // Actualización lenta del ancla para acompañar cambios de pose e iluminación.
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
      // RN-08: silencio mientras sea la misma persona; un cambio abre un encuentro nuevo.
      if (o.usable && o.embedding && this.tracksChange(o.embedding)) this.newEncounter(o.tMs);
      else return null;
    }

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
      // Nadie del círculo. No se registra nada biométrico (RF-09): sólo se decide si decirlo.
      this.state = 'descartando';
      return this.emit({ kind: 'unknown', identityId: null, sMax, hits: rejects, ...base }, o);
    }
    return null;
  }
}
