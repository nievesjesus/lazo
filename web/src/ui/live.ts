// Wearer view. By default: a soft frame around the face. With «technical details»: detection
// box, five landmarks and a quality label (for demos).
import type { FrameResult } from '../pipeline/pipeline';
import { num } from './util';

const COLORS = { match: '#ffffff', abstain: '#f0c96a', reject: '#b9b9b9' } as const;

export function drawFrame(
  canvas: HTMLCanvasElement,
  frame: HTMLCanvasElement,
  res: FrameResult | null,
  mirror: boolean,
  details = false,
) {
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  if (mirror) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(frame, 0, 0);
  ctx.restore();

  if (!res?.face) return;
  const f = res.face;
  const fx = (x: number) => (mirror ? canvas.width - x : x);
  const x1 = Math.min(fx(f.box[0]), fx(f.box[2]));
  const x2 = Math.max(fx(f.box[0]), fx(f.box[2]));
  const [, y1, , y2] = f.box;
  const color = res.zone ? COLORS[res.zone] : 'rgba(255,255,255,0.85)';
  const unit = Math.max(1.5, canvas.width / 640);

  if (!details) {
    // Rounded corners: signal «I'm looking at this face» without technical details.
    const w = x2 - x1, h = y2 - y1, pad = 0.08 * w;
    const L = Math.min(w, h) * 0.22;
    const [a, b, c, d] = [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * unit;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [px, py, dx, dy] of [[a, b, 1, 1], [c, b, -1, 1], [a, d, 1, -1], [c, d, -1, -1]] as const) {
      ctx.moveTo(px, py + dy * L);
      ctx.quadraticCurveTo(px, py, px + dx * L, py);
    }
    ctx.stroke();
    return;
  }

  ctx.lineWidth = 2 * unit;
  ctx.strokeStyle = color;
  ctx.setLineDash(res.zone === 'match' ? [] : [8 * unit, 6 * unit]);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  for (const [x, y] of f.kps) {
    ctx.beginPath();
    ctx.arc(fx(x), y, 3 * unit, 0, Math.PI * 2);
    ctx.fill();
  }
  let label = `rostro ${num(f.score)}`;
  if (res.quality && !res.quality.ok) label += ` · ${res.quality.reason}`;
  else if (res.sMax > -1) label += ` · s = ${num(res.sMax)}`;
  ctx.font = `600 ${12 * unit}px ui-sans-serif, system-ui, sans-serif`;
  const tw = ctx.measureText(label).width + 12 * unit;
  const th = 20 * unit;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x1, y1 - th, tw, th);
  ctx.fillStyle = '#111';
  ctx.fillText(label, x1 + 6 * unit, y1 - 6 * unit);
}
