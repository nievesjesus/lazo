// Galería cerrada y cifrada (RF-05, RF-10 a RF-12, RN-01, RN-06, RN-07).
//
// Cada identidad se cifra con AES-256-GCM usando una CryptoKey NO extraíble generada por
// WebCrypto: el navegador la guarda en IndexedDB pero el código JS no puede leer sus bytes
// (equivalente web del Android Keystore). Nunca se guarda una imagen.
import { ENROLLMENT, MAX_GALLERY } from '../pipeline/config';
import { dot } from '../pipeline/models';
import * as idb from './db';

export interface Consent {
  identification: boolean;
  notes: boolean;
  encounterLog: boolean;
}

export interface Identity {
  id: string;
  name: string;
  relation: string;
  phrase: string;
  context: string;
  notes: string[];
  consent: Consent;
  template: Float32Array;
  validShots: number;
  enrolledAt: number;
  expiresAt: number;
}

interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

const MONTH_MS = 30 * 24 * 3600 * 1000;
let keyP: Promise<CryptoKey> | null = null;
let cache: Map<string, Identity> | null = null;

function key(): Promise<CryptoKey> {
  keyP ??= (async () => {
    const existing = await idb.get<CryptoKey>('keys', 'gallery');
    if (existing) return existing;
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb.put('keys', 'gallery', k);
    return k;
  })();
  return keyP;
}

async function seal(ident: Identity): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({ ...ident, template: Array.from(ident.template) }));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(ident.id) }, await key(), payload,
  );
  return { iv, data };
}

async function open(id: string, s: Sealed): Promise<Identity> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: s.iv as BufferSource, additionalData: new TextEncoder().encode(id) }, await key(), s.data,
  );
  const obj = JSON.parse(new TextDecoder().decode(plain));
  return { ...obj, template: Float32Array.from(obj.template) };
}

async function audit(op: string, ref: string, detail = '') {
  await idb.put('audit', `${Date.now()}-${crypto.randomUUID()}`, { ts: Date.now(), op, ref, detail });
}

async function load(): Promise<Map<string, Identity>> {
  if (!cache) {
    cache = new Map();
    for (const [id, s] of await idb.all<Sealed>('identities')) cache.set(id as string, await open(id as string, s));
  }
  return cache;
}

async function save(ident: Identity) {
  await idb.put('identities', ident.id, await seal(ident));
  (await load()).set(ident.id, ident);
}

export const isExpired = (i: Identity) => Date.now() >= i.expiresAt;
export const isWeak = (i: Identity) => i.validShots < ENROLLMENT.minValidShots;

export async function list(): Promise<Identity[]> {
  return [...(await load()).values()].sort((a, b) => a.enrolledAt - b.enrolledAt);
}

export async function active(): Promise<Identity[]> {
  return (await list()).filter((i) => !isExpired(i) && i.consent.identification);
}

export async function getIdentity(id: string) {
  return (await load()).get(id);
}

/** RN-01: sólo lo invoca el flujo de alta, después del consentimiento del titular. */
export async function enroll(p: {
  name: string; relation: string; phrase?: string; context?: string;
  template: Float32Array; consent: Consent; validShots: number;
}): Promise<Identity> {
  if (!p.consent.identification) throw new Error('Sin consentimiento de identificación no se crea plantilla');
  if ((await load()).size >= MAX_GALLERY) throw new Error(`La galería admite hasta ${MAX_GALLERY} identidades`);
  const now = Date.now();
  const ident: Identity = {
    id: crypto.randomUUID(),
    name: p.name,
    relation: p.relation,
    phrase: p.phrase || `Es ${p.name}, ${p.relation}.`,
    context: p.consent.notes ? (p.context ?? '') : '',
    notes: [],
    consent: p.consent,
    template: p.template,
    validShots: p.validShots,
    enrolledAt: now,
    expiresAt: now + ENROLLMENT.consentMonths * MONTH_MS,
  };
  await save(ident);
  await audit('alta', ident.id, `tomas=${p.validShots}`);
  return ident;
}

/** RF-10: el cuidador edita vínculo, frase y notas; nunca la plantilla. */
export async function update(id: string, changes: Partial<Pick<Identity, 'relation' | 'phrase' | 'notes' | 'context'>>) {
  const ident = (await load()).get(id);
  if (!ident) return;
  if (!ident.consent.notes) {
    delete changes.notes;
    delete changes.context;
  }
  Object.assign(ident, changes);
  await save(ident);
  await audit('edicion', id, Object.keys(changes).join(','));
}

/** RF-11 / RN-06: borrado inmediato e irreversible; queda sólo la constancia en la auditoría. */
export async function revoke(id: string, by = 'titular') {
  await idb.del('identities', id);
  (await load()).delete(id);
  await audit('revocacion', id, by);
}

/** Etapa 06 · búsqueda 1:N exhaustiva. */
export async function search(q: Float32Array): Promise<{ best: Identity | null; sMax: number }> {
  let best: Identity | null = null, sMax = -1;
  for (const i of await active()) {
    const s = dot(q, i.template);
    if (s > sMax) [best, sMax] = [i, s];
  }
  return { best, sMax };
}

export async function auditLog() {
  return (await idb.all<{ ts: number; op: string; ref: string; detail: string }>('audit')).map(([, v]) => v);
}

export async function wipeAll() {
  for (const i of await list()) await revoke(i.id, 'cuidador · borrado total');
}
