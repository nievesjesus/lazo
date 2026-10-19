// Stages 02 and 04 in the browser: quality metrics, intensity correction and
// alignment via a similarity transform.

export type Point = [number, number];

export const ARCFACE_TEMPLATE: Point[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** 2D Umeyama: matrix [a, b, tx; c, d, ty] with a=d=s·cosθ, c=−b=s·sinθ. Closed form. */
export function similarityTransform(src: Point[], dst: Point[] = ARCFACE_TEMPLATE): number[] {
  const n = src.length;
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i][0]; msy += src[i][1]; mdx += dst[i][0]; mdy += dst[i][1];
  }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let sxx = 0, sxy = 0, varS = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - msx, y = src[i][1] - msy;
    const u = dst[i][0] - mdx, v = dst[i][1] - mdy;
    sxx += x * u + y * v; // Σ (src · dst)
    sxy += x * v - y * u; // Σ (src × dst)
    varS += x * x + y * y;
  }
  const theta = Math.atan2(sxy, sxx);
  const s = Math.hypot(sxx, sxy) / varS;
  const a = s * Math.cos(theta), c = s * Math.sin(theta);
  const tx = mdx - (a * msx - c * msy);
  const ty = mdy - (c * msx + a * msy);
  return [a, -c, tx, c, a, ty];
}

/** Canonical 112×112 crop: affine warp with the canvas's bilinear interpolation. */
export function alignCrop(source: CanvasImageSource, kps: Point[], out: HTMLCanvasElement): number[] {
  const m = similarityTransform(kps);
  out.width = out.height = 112;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 112, 112);
  // x' = m0·x + m1·y + m2 ; y' = m3·x + m4·y + m5  ⇒ setTransform(a, b, c, d, e, f) = (m0, m3, m1, m4, m2, m5)
  ctx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return m;
}

export function toGray(data: Uint8ClampedArray): Float32Array {
  const g = new Float32Array(data.length / 4);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return g;
}

/** V = Var(∇²I) with the mask [[0,1,0],[1,−4,1],[0,1,0]] (variance of the Laplacian). */
export function sharpness(gray: Float32Array, w: number, h: number): number {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += l; sum2 += l * l; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export function meanOf(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

/** Power-law intensity correction (s = r^γ) toward a target mean. Applied in place. */
export function gammaCorrect(img: ImageData, target = 120): void {
  const g = toGray(img.data);
  const mean = Math.max(meanOf(g), 1) / 255;
  const gamma = Math.min(2.5, Math.max(0.4, Math.log(target / 255) / Math.log(mean)));
  if (Math.abs(gamma - 1) < 0.05) return;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, gamma) * 255);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
}

/** Out-of-plane turn: horizontal offset of the nose from the eye midpoint / interocular distance. */
export function yawRatio(kps: Point[]): number {
  const mx = (kps[0][0] + kps[1][0]) / 2;
  const iod = Math.hypot(kps[1][0] - kps[0][0], kps[1][1] - kps[0][1]) + 1e-6;
  return (kps[2][0] - mx) / iod;
}
