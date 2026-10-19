// Eight-stage pipeline in the browser. The frame lives only inside `process`:
// the working canvas is overwritten on every cycle and nothing is persisted.
import * as gallery from '../store/gallery';
import { ABSTAIN_PHRASE, DEFAULT_DECISION, type DecisionConfig, QUALITY, UNKNOWN_PHRASE } from './config';
import { type Announcement, classify, DecisionEngine, type State, type Zone } from './decision';
import { alignCrop, gammaCorrect, meanOf, sharpness, toGray, yawRatio } from './imageops';
import { type Face, FaceDetector, FaceEmbedder, faceHeight } from './models';

export interface Quality {
  ok: boolean;
  reason: string | null;
  sharpness: number;
  brightness: number;
  facePx: number;
  yaw: number;
}

export interface FrameResult {
  tMs: number;
  face: Face | null;
  quality: Quality | null;
  candidate: gallery.Identity | null;
  sMax: number;
  zone: Zone | null;
  state: State;
  announcement: Announcement | null;
  phrase: string | null;
  identity: gallery.Identity | null;
  timings: Record<string, number>;
}

export class Pipeline {
  engine: DecisionEngine;
  private work = document.createElement('canvas');
  private crop = document.createElement('canvas');

  private constructor(private det: FaceDetector, private emb: FaceEmbedder, cfg: DecisionConfig) {
    this.engine = new DecisionEngine(cfg);
  }

  static async load(cfg: DecisionConfig = DEFAULT_DECISION) {
    const [det, emb] = await Promise.all([FaceDetector.load(), FaceEmbedder.load()]);
    return new Pipeline(det, emb, { ...cfg });
  }

  /** Stages 02–05 on a frame: preprocess, detect, align, measure quality and (if it passes) compute the embedding. */
  async analyze(frame: HTMLCanvasElement, opts: { allowProfile?: boolean } = {}) {
    const t = performance.now();
    const timings: Record<string, number> = {};
    // Stage 02: intensity correction on a working copy.
    this.work.width = frame.width;
    this.work.height = frame.height;
    const wctx = this.work.getContext('2d', { willReadFrequently: true })!;
    const img = frame.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, frame.width, frame.height);
    gammaCorrect(img);
    wctx.putImageData(img, 0, 0);
    timings.preproceso = performance.now() - t;

    const faces = await this.det.detect(this.work, QUALITY.minDetScore);
    timings.deteccion = performance.now() - t - timings.preproceso;
    const face = faces[0] ?? null;
    if (!face) return { face: null, quality: null, embedding: null, timings, faces: 0 };

    alignCrop(this.work, face.kps, this.crop);
    const cropData = this.crop.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, 112, 112);
    const gray = toGray(cropData.data);
    const q: Quality = {
      ok: true, reason: null,
      sharpness: sharpness(gray, 112, 112),
      brightness: meanOf(gray),
      facePx: faceHeight(face),
      yaw: yawRatio(face.kps),
    };
    if (face.score < QUALITY.minDetScore) q.reason = 'detección débil';
    else if (q.facePx < QUALITY.minFacePx) q.reason = 'rostro pequeño';
    else if (q.sharpness < QUALITY.minSharpness) q.reason = 'borroso';
    else if (q.brightness < QUALITY.minBrightness) q.reason = 'poca luz';
    else if (q.brightness > QUALITY.maxBrightness) q.reason = 'sobreexpuesto';
    else if (!opts.allowProfile && Math.abs(q.yaw) > QUALITY.maxYawRatio) q.reason = 'de perfil';
    q.ok = q.reason === null;
    timings.alineacion = performance.now() - t - timings.preproceso - timings.deteccion;

    let embedding: Float32Array | null = null;
    if (q.ok) {
      const t2 = performance.now();
      embedding = await this.emb.embed(cropData);
      timings.embedding = performance.now() - t2;
    }
    return { face, quality: q, embedding, timings, faces: faces.length };
  }

  async process(frame: HTMLCanvasElement, tMs: number): Promise<FrameResult> {
    const res: FrameResult = {
      tMs, face: null, quality: null, candidate: null, sMax: -1, zone: null,
      state: this.engine.state, announcement: null, phrase: null, identity: null, timings: {},
    };
    const a = await this.analyze(frame);
    res.face = a.face;
    res.quality = a.quality;
    res.timings = a.timings;

    if (!a.face) {
      this.engine.step({ tMs, facePresent: false, usable: false });
      res.state = this.engine.state;
      return res;
    }
    if (!a.embedding) {
      this.engine.step({ tMs, facePresent: true, usable: false });
      res.state = this.engine.state;
      return res;
    }

    const t = performance.now();
    const { best, sMax } = await gallery.search(a.embedding);
    res.timings.busqueda = performance.now() - t;
    const weak = !!best && gallery.isWeak(best);
    const [lo, hi] = this.engine.thresholds(weak);
    res.candidate = best;
    res.sMax = sMax;
    res.zone = classify(sMax, lo, hi);
    const ann = this.engine.step({ tMs, facePresent: true, usable: true, identityId: best?.id ?? null, sMax, weakTemplate: weak, embedding: a.embedding });
    res.state = this.engine.state;
    res.announcement = ann;
    if (ann?.kind === 'match') {
      res.identity = (await gallery.getIdentity(ann.identityId!)) ?? null;
      res.phrase = res.identity?.phrase ?? null;
    } else if (ann?.kind === 'abstain') {
      res.phrase = ABSTAIN_PHRASE;
    } else if (ann?.kind === 'unknown') {
      res.phrase = UNKNOWN_PHRASE;
    }
    return res;
  }
}
