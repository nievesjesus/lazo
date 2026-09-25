import { DEFAULT_DECISION } from '../pipeline/config';
import * as idb from './db';

export interface Calibration {
  /** Curva DET exportada por `mnemo-eval` (core/): τ → FPIR, FNIR. */
  tau: number[];
  fpir: number[];
  fnir: number[];
  galleryN: number;
}

export interface Settings {
  privacyMode: boolean;
  onDemand: boolean;       // «sólo a pedido»: identificación disparada por «¿quién es?»
  tauHigh: number;
  dwellMs: number;
  facing: 'user' | 'environment';
  voice: boolean;
  calibration: Calibration | null;
}

export const DEFAULTS: Settings = {
  privacyMode: false,
  onDemand: false,
  tauHigh: DEFAULT_DECISION.tauHigh,
  dwellMs: DEFAULT_DECISION.dwellMs,
  facing: 'user',
  voice: true,
  calibration: null,
};

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULTS, ...((await idb.get<Settings>('settings', 'app')) ?? {}) };
}

export async function saveSettings(s: Settings) {
  await idb.put('settings', 'app', s);
}

/** Interpola FPIR/FNIR estimados para un τ a partir de la curva de calibración. */
export function estimate(c: Calibration, tau: number): { fpir: number; fnir: number } {
  const i = c.tau.findIndex((t) => t >= tau);
  if (i <= 0) return { fpir: c.fpir[0], fnir: c.fnir[0] };
  const t0 = c.tau[i - 1], t1 = c.tau[i], w = (tau - t0) / (t1 - t0 || 1);
  return { fpir: c.fpir[i - 1] + w * (c.fpir[i] - c.fpir[i - 1]), fnir: c.fnir[i - 1] + w * (c.fnir[i] - c.fnir[i - 1]) };
}
