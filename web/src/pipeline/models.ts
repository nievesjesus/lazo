// Etapas 03 y 05: RetinaFace-500MF (SCRFD) y MobileFaceNet (ArcFace) con onnxruntime-web.
// Los mismos archivos ONNX que usa core/ — servidos desde el propio origen, sin red externa.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

import { DET_SIZE } from './config';
import type { Point } from './imageops';

// El bundle ya incluye el glue JS; sólo el binario .wasm se sirve aparte, desde el mismo origen.
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const STRIDES = [8, 16, 32];
const NUM_ANCHORS = 2;

export interface Face {
  box: [number, number, number, number];
  score: number;
  kps: Point[];
}

export const faceHeight = (f: Face) => f.box[3] - f.box[1];

function iou(a: Face['box'], b: Face['box']) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-9);
}

function nms(faces: Face[], thresh = 0.4): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep: Face[] = [];
  for (const f of sorted) if (keep.every((k) => iou(k.box, f.box) <= thresh)) keep.push(f);
  return keep;
}

async function createSession(url: string) {
  return ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}

export class FaceDetector {
  private canvas = document.createElement('canvas');
  private constructor(private session: ort.InferenceSession, private size: number) {
    this.canvas.width = this.canvas.height = size;
  }

  static async load(size = DET_SIZE) {
    return new FaceDetector(await createSession(`${import.meta.env.BASE_URL}models/det_500m.onnx`), size);
  }

  async detect(source: HTMLCanvasElement, scoreThresh = 0.5): Promise<Face[]> {
    const { width: w0, height: h0 } = source;
    const S = this.size;
    const scale = S / Math.max(w0, h0);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(source, 0, 0, Math.round(w0 * scale), Math.round(h0 * scale));
    const px = ctx.getImageData(0, 0, S, S).data;

    // NCHW, RGB, (x − 127,5) / 128
    const plane = S * S;
    const input = new Float32Array(3 * plane);
    for (let i = 0, j = 0; j < plane; i += 4, j++) {
      input[j] = (px[i] - 127.5) / 128;
      input[j + plane] = (px[i + 1] - 127.5) / 128;
      input[j + 2 * plane] = (px[i + 2] - 127.5) / 128;
    }
    const out = await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) });
    const names = this.session.outputNames; // orden: scores×3, bbox×3, kps×3

    const faces: Face[] = [];
    STRIDES.forEach((stride, si) => {
      const scores = out[names[si]].data as Float32Array;
      const boxes = out[names[si + 3]].data as Float32Array;
      const kps = out[names[si + 6]].data as Float32Array;
      const fw = S / stride;
      for (let k = 0; k < scores.length; k++) {
        if (scores[k] < scoreThresh) continue;
        const cell = Math.floor(k / NUM_ANCHORS);
        const cx = (cell % fw) * stride, cy = Math.floor(cell / fw) * stride;
        const b = boxes.subarray(k * 4, k * 4 + 4);
        const box: Face['box'] = [
          (cx - b[0] * stride) / scale, (cy - b[1] * stride) / scale,
          (cx + b[2] * stride) / scale, (cy + b[3] * stride) / scale,
        ];
        const pts: Point[] = [];
        for (let p = 0; p < 5; p++) {
          pts.push([(cx + kps[k * 10 + 2 * p] * stride) / scale, (cy + kps[k * 10 + 2 * p + 1] * stride) / scale]);
        }
        faces.push({ box, score: scores[k], kps: pts });
      }
    });
    // CU-02 A3: con varios rostros se prioriza el más cercano (el más alto).
    return nms(faces).sort((a, b) => faceHeight(b) - faceHeight(a));
  }
}

export class FaceEmbedder {
  private constructor(private session: ort.InferenceSession) {}

  static async load() {
    return new FaceEmbedder(await createSession(`${import.meta.env.BASE_URL}models/w600k_mbf.onnx`));
  }

  /** Recorte alineado 112×112 → vector de 512 normalizado (ec. 5 ⇒ coseno = producto interno). */
  async embed(crop: ImageData): Promise<Float32Array> {
    const plane = 112 * 112;
    const input = new Float32Array(3 * plane);
    const px = crop.data;
    for (let i = 0, j = 0; j < plane; i += 4, j++) {
      input[j] = (px[i] - 127.5) / 127.5;
      input[j + plane] = (px[i + 1] - 127.5) / 127.5;
      input[j + 2 * plane] = (px[i + 2] - 127.5) / 127.5;
    }
    const out = await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) });
    return l2normalize(out[this.session.outputNames[0]].data as Float32Array);
  }
}

export function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) + 1e-12;
  const r = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = v[i] / n;
  return r;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** RF-04: centroide normalizado de las tomas válidas. */
export function centroid(vs: Float32Array[]): Float32Array {
  const c = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  return l2normalize(c);
}
