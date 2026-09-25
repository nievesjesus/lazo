// P-07 / P-08 · Vista del portador. Dibuja el cuadro, el recuadro de detección, los cinco puntos
// y las tarjetas de afirmación o abstención. En las gafas sin display sólo existe el audio.
import type { FrameResult } from '../pipeline/pipeline';
import { num } from './util';

const COLORS = { match: '#ffffff', abstain: '#e8c872', reject: '#9a9a9a' } as const;

export function drawFrame(
  canvas: HTMLCanvasElement,
  frame: HTMLCanvasElement,
  res: FrameResult | null,
  mirror: boolean,
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
  // Viñeta inferior para legibilidad de las tarjetas.
  const g = ctx.createLinearGradient(0, canvas.height * 0.55, 0, canvas.height);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!res?.face) return;
  const f = res.face;
  const fx = (x: number) => (mirror ? canvas.width - x : x);
  const x1 = Math.min(fx(f.box[0]), fx(f.box[2]));
  const x2 = Math.max(fx(f.box[0]), fx(f.box[2]));
  const [, y1, , y2] = f.box;
  const color = res.zone ? COLORS[res.zone] : '#cfcfcf';
  const unit = Math.max(1.5, canvas.width / 640);

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
  else if (res.quality) label += ` · nítido · 112×112`;
  ctx.font = `600 ${12 * unit}px ui-sans-serif, system-ui, sans-serif`;
  const tw = ctx.measureText(label).width + 12 * unit;
  const th = 20 * unit;
  ctx.fillStyle = res.zone === 'abstain' ? '#d9d9d9' : '#ffffff';
  ctx.fillRect(x1, y1 - th, tw, th);
  ctx.fillStyle = '#111';
  ctx.fillText(label, x1 + 6 * unit, y1 - 6 * unit);
}
