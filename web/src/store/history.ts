// Encounter history and anonymous counter of discarded detections.
// Only time, identity and similarity. Never images, audio or location. 7-day retention.
import { HISTORY_DAYS } from '../pipeline/config';
import * as idb from './db';

export interface Encounter {
  ts: number;
  kind: 'aviso' | 'abstencion' | 'desconocido';
  identityId: string | null;
  similarity: number;
  latencyMs: number;
  hits: string;
  reportedError?: boolean;
}

const RETENTION_MS = HISTORY_DAYS * 24 * 3600 * 1000;
const today = () => new Date().toISOString().slice(0, 10);

export async function purge() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [k, e] of await idb.all<Encounter>('encounters')) if (e.ts < cutoff) await idb.del('encounters', k);
}

export async function log(e: Encounter) {
  await idb.put('encounters', e.ts, e);
  await purge();
}

export async function recent(): Promise<Encounter[]> {
  await purge();
  return (await idb.all<Encounter>('encounters')).map(([, e]) => e).sort((a, b) => b.ts - a.ts);
}

export async function reportError(ts: number) {
  const e = await idb.get<Encounter>('encounters', ts);
  if (e) await idb.put('encounters', ts, { ...e, reportedError: true });
}

export async function forgetIdentity(id: string) {
  for (const [k, e] of await idb.all<Encounter>('encounters')) if (e.identityId === id) await idb.del('encounters', k);
}

export async function countDiscard() {
  const k = `descartes-${today()}`;
  await idb.put('counters', k, ((await idb.get<number>('counters', k)) ?? 0) + 1);
}

export async function discardsToday(): Promise<number> {
  return (await idb.get<number>('counters', `descartes-${today()}`)) ?? 0;
}
