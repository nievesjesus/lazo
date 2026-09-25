import { describe, expect, it } from 'vitest';

import { DEFAULT_DECISION } from '../src/pipeline/config';
import { DecisionEngine } from '../src/pipeline/decision';
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
