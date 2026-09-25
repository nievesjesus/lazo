import { describe, expect, it } from 'vitest';

import { DEFAULT_DECISION } from '../src/pipeline/config';
import { DecisionEngine } from '../src/pipeline/decision';
import { isAsk } from '../src/voice/listener';
import { ARCFACE_TEMPLATE, type Point, similarityTransform } from '../src/pipeline/imageops';

const run = (e: DecisionEngine, sims: number[], id = 'a', weak = false) => {
  let out = null;
  sims.forEach((s, k) => { out = e.step({ tMs: k * 100, facePresent: true, usable: true, identityId: id, sMax: s, weakTemplate: weak }) ?? out; });
  return out as ReturnType<DecisionEngine['step']>;
};

describe('regla de decisión (mismos casos que core/tests)', () => {
  const cfg = { ...DEFAULT_DECISION, dwellMs: 0 };
  it('afirma con 3 de 4', () => expect(run(new DecisionEngine(cfg), [0.6, 0.2, 0.6, 0.6])?.kind).toBe('match'));
  it('se abstiene en la banda y no nombra', () => {
    const a = run(new DecisionEngine(cfg), [0.33, 0.35, 0.31, 0.34]);
    expect(a?.kind).toBe('abstain');
    expect(a?.identityId).toBeNull();
  });
  it('una frase por encuentro', () => {
    const e = new DecisionEngine({ ...cfg, encounterGapMs: 1000 });
    expect(run(e, [0.6, 0.6, 0.6])).not.toBeNull();
    expect(run(e, Array(8).fill(0.6))).toBeNull();
    e.step({ tMs: 10_000, facePresent: false, usable: false });
    expect(run(e, [0.6, 0.6, 0.6])).not.toBeNull();
  });
  it('plantilla débil eleva el umbral', () => expect(run(new DecisionEngine(cfg), [0.4, 0.4, 0.4, 0.4], 'a', true)?.kind).toBe('abstain'));
  it('respeta la permanencia mínima', () => expect(run(new DecisionEngine({ ...cfg, dwellMs: 1500 }), [0.6, 0.6, 0.6, 0.6])).toBeNull());
});

// Embeddings sintéticos: la misma persona = mismo vector; otra persona = vector ortogonal.
const face = (k: number) => { const v = new Float32Array(512); v[k] = 1; return v; };
const see = (e: DecisionEngine, t0: number, n: number, id: string | null, s: number, emb: Float32Array) => {
  let out = null;
  for (let k = 0; k < n; k++) out = e.step({ tMs: t0 + k * 100, facePresent: true, usable: true, identityId: id, sMax: s, embedding: emb }) ?? out;
  return out as ReturnType<DecisionEngine['step']>;
};

describe('cambio de persona y desconocidos', () => {
  const cfg = { ...DEFAULT_DECISION, dwellMs: 0 };
  it('al cambiar de cara vuelve a anunciar (con el aviso automático activo)', () => {
    const e = new DecisionEngine({ ...cfg });
    expect(see(e, 0, 4, 'marta', 0.7, face(0))?.identityId).toBe('marta');
    expect(see(e, 400, 6, 'marta', 0.7, face(0))).toBeNull();          // misma persona: silencio
    const b = see(e, 1000, 8, 'tomas', 0.7, face(1));
    expect(b?.identityId).toBe('tomas');
    expect(b?.reason).toBe('cambio');
  });
  it('sin el aviso automático, el cambio queda en silencio hasta que pregunten', () => {
    const e = new DecisionEngine({ ...cfg, announceOnChange: false });
    see(e, 0, 4, 'marta', 0.7, face(0));
    expect(see(e, 400, 8, 'tomas', 0.7, face(1))).toBeNull();
    e.request();
    const a = see(e, 1300, 4, 'tomas', 0.7, face(1));
    expect(a?.identityId).toBe('tomas');
    expect(a?.reason).toBe('pedido');
  });
  it('dice «no es nadie conocido» y luego reconoce a quien llega', () => {
    const e = new DecisionEngine({ ...cfg });
    expect(see(e, 0, 4, null, 0.05, face(2))?.kind).toBe('unknown');
    expect(see(e, 400, 8, 'marta', 0.7, face(0))?.identityId).toBe('marta');
  });
  it('con «avisar desconocidos» apagado no habla… salvo que pregunten', () => {
    const e = new DecisionEngine({ ...cfg, announceUnknown: false });
    expect(see(e, 0, 6, null, 0.05, face(2))).toBeNull();
    e.request();
    expect(see(e, 700, 4, null, 0.05, face(2))?.kind).toBe('unknown');
  });
  it('«¿quién es?» responde sin esperar la permanencia mínima', () => {
    const e = new DecisionEngine({ ...DEFAULT_DECISION, dwellMs: 1500 });
    e.request();
    expect(see(e, 0, 3, 'marta', 0.7, face(0))?.identityId).toBe('marta');
  });
});

describe('alineación', () => {
  it('recupera una similitud conocida', () => {
    const th = (15 * Math.PI) / 180, s = 1.7, t = [20, -5];
    const src: Point[] = ARCFACE_TEMPLATE;
    const dst: Point[] = src.map(([x, y]) => [s * (x * Math.cos(th) - y * Math.sin(th)) + t[0], s * (x * Math.sin(th) + y * Math.cos(th)) + t[1]]);
    const m = similarityTransform(src, dst);
    expect(m[0]).toBeCloseTo(s * Math.cos(th), 4);
    expect(m[3]).toBeCloseTo(s * Math.sin(th), 4);
    expect(m[2]).toBeCloseTo(20, 3);
    expect(m[5]).toBeCloseTo(-5, 3);
  });
});

describe('frases que disparan «¿quién es?»', () => {
  it.each(['¿Quién es?', 'quien es', ' ¿Quién está ahí?', '¿Cómo se llama?', 'Oye, ¿quién me habla?', '¿Qué es?', 'Quién.'])('%s', (t) => expect(isAsk(t)).toBe(true));
  it.each(['Es Marta, tu hija.', 'hola, ¿cómo estás?', 'No es nadie conocido.', '¿Qué es eso?', 'Qué es lo que pasa'])('no: %s', (t) => expect(isAsk(t)).toBe(false));
});
