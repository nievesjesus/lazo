// Latency of the web pipeline (onnxruntime-web WASM) in headless Chrome.
//
// Starts its own Vite (port BENCH_PORT, 5311 by default), opens the app and imports the Vite modules inside the
// page (`await import('/src/pipeline/pipeline.ts')`) to measure `Pipeline.process` on frames drawn onto a
// canvas from the synthetic faces in assets/faces (served with page.route, without touching web/public).
// The gallery (the page's real IndexedDB) holds 50 identities: Marta (5 shots) and 49 random templates.
// It runs with and without cross-origin isolation: the second case strips COOP/COEP from the responses, so
// `crossOriginIsolated` ends up false and models.ts uses 1 WASM thread instead of min(4, cores).
// Usage:  node e2e/bench.mjs [frames=200] [output=../docs/eval/latencia_web.json]
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FACES = join(WEB, '..', 'assets', 'faces');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.BENCH_PORT ?? 5311);
const N = Number(process.argv[2] ?? 200);
const OUT = resolve(process.argv[3] ?? join(WEB, '..', 'docs', 'eval', 'latencia_web.json'));
const WARMUP = 10;
const MARTA = ['marta_frontal', 'marta_sonrisa', 'marta_giro_izq', 'marta_giro_der', 'marta_luz_baja'];
const SCENES = [...MARTA, 'marta_barbijo', 'tomas_frontal', 'desconocido_frontal'];

// --- isolated Vite server (like scripts/e2e.sh) -------------------------------------------------
execFileSync('node', ['scripts/copy-assets.mjs'], { cwd: WEB, stdio: 'ignore' });
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: WEB, stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-vite.pid); } catch {} }; // whole group: npx leaves vite as a child process
process.on('exit', stop);
const url = `http://localhost:${PORT}/`;
for (let i = 0; i < 120; i++) {
  if (await fetch(url).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}

// --- code that runs inside the page ---------------------------------------------------------------
async function inPage({ names, marta, n, warmup, w, h }) {
  const { Pipeline } = await import('/src/pipeline/pipeline.ts');
  const gallery = await import('/src/store/gallery.ts');
  const { centroid, l2normalize } = await import('/src/pipeline/models.ts');

  let t0 = performance.now();
  const pipe = await Pipeline.load();
  const loadMs = performance.now() - t0;

  const imgs = {};
  for (const name of names) imgs[name] = await createImageBitmap(await (await fetch(`/__bench/${name}.png`)).blob());

  // Seeded PRNG (mulberry32): same frames in both variants.
  let seed = 12345;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const FACE = [625, 400]; // approximate face center in the 1200×896 images
  const draw = (img, jitter) => {
    const s = (w / img.width) * (jitter ? 1 + rnd() * 0.17 : 1.15);
    const tx = Math.min(0, Math.max(w - img.width * s, w / 2 - FACE[0] * s + (jitter ? (rnd() * 120 - 60) : 0)));
    const ty = Math.min(0, Math.max(h - img.height * s, h / 2 - FACE[1] * s + (jitter ? (rnd() * 120 - 60) : 0)));
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  // Gallery of 50: Marta with her 5 real shots + 49 normalized random templates.
  const embs = [];
  for (const m of marta) { draw(imgs[m], false); const a = await pipe.analyze(canvas, { allowProfile: true }); if (a.embedding) embs.push(a.embedding); }
  const consent = { identification: true, notes: false, encounterLog: false };
  await gallery.enroll({ name: 'Marta', relation: 'tu hija', template: centroid(embs), consent, validShots: embs.length });
  for (let k = 0; k < 49; k++) {
    const v = new Float32Array(512);
    for (let i = 0; i < 512; i += 2) { // Box-Muller
      const r = Math.sqrt(-2 * Math.log(1 - rnd())), a = 2 * Math.PI * rnd();
      v[i] = r * Math.cos(a); v[i + 1] = r * Math.sin(a);
    }
    await gallery.enroll({ name: `Vecino ${k}`, relation: 'vecino', template: l2normalize(v), consent, validShots: 5 });
  }
  const galleryN = (await gallery.active()).length;

  const per = {}, totals = [], control = {};
  for (let i = 0; i < n + warmup; i++) {
    const scene = names[i % names.length];
    draw(imgs[scene], true);
    const t = performance.now();
    const res = await pipe.process(canvas, i * 100);
    const total = performance.now() - t;
    if (i < warmup) continue;
    const sum = Object.values(res.timings).reduce((a, b) => a + b, 0);
    res.timings.decision_y_resto = Math.max(0, total - sum); // engine.step, getIdentity and waits between stages
    for (const [k, v] of Object.entries(res.timings)) (per[k] ??= []).push(v);
    totals.push(total);
    (control[scene] ??= []).push([res.sMax, res.candidate?.name ?? null, res.quality?.ok ?? null]);
  }
  return {
    cuadro: `${w}×${h}`, loadMs, galleryN, per, totals, control,
    crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
  };
}

// --- voice: quantized Whisper base (transformers.js, WASM) in the app's worker --------------------------------
// The phrase «¿Quién es?» spoken with the system voice (like e2e/make_fixtures.py). The segment mimics what the VAD in
// listener.ts delivers: 320 ms of pre-roll + phrase + 700 ms of trailing silence. The e2e's full 6 s clip is measured too.
function synthSpeech() {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-voz-'));
  execFileSync('say', ['-v', 'Eddy (Español (México))', '-o', join(dir, 'q.aiff'), '¿Quién es?']);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'q.aiff'), join(dir, 'q.wav')]);
  const buf = readFileSync(join(dir, 'q.wav'));
  const i = buf.indexOf('data') + 8; // minimal afconvert header: «data» + 4-byte size
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + i, buf.byteOffset + buf.length - ((buf.length - i) % 2)));
  return Array.from(pcm, (v) => v / 32768);
}

async function voiceInPage({ speech, reps }) {
  const worker = new Worker('/src/voice/whisper.worker.ts', { type: 'module' });
  const next = (type) => new Promise((resolve, reject) => {
    worker.onmessage = (e) => (e.data.type === type ? resolve(e.data) : e.data.type === 'error' ? reject(new Error(e.data.message)) : null);
  });
  const t0 = performance.now();
  const ready = next('ready');
  worker.postMessage({ type: 'load' });
  await ready;
  const loadMs = performance.now() - t0;
  const zeros = (s) => new Array(Math.round(16000 * s)).fill(0);
  const clips = { segmento_vad: [...zeros(0.32), ...speech, ...zeros(0.7)], clip_completo: [...zeros(2), ...speech, ...zeros(3)] };
  const out = { loadMs, crossOriginIsolated: self.crossOriginIsolated };
  for (const [name, arr] of Object.entries(clips)) {
    const ms = [], wall = [];
    let text = '';
    for (let k = 0; k < reps + 1; k++) { // the first call is discarded (warm-up) and reported separately
      const audio = new Float32Array(arr);
      const done = next('text');
      const t = performance.now();
      worker.postMessage({ type: 'transcribe', id: k, audio }, [audio.buffer]);
      const m = await done;
      const w = performance.now() - t;
      text = m.text;
      if (k === 0) out[`${name}_primera_llamada_ms`] = w;
      else { ms.push(m.ms); wall.push(w); }
    }
    out[name] = { duracion_s: arr.length / 16000, texto: text, ms_worker: ms, ms_pared: wall };
  }
  worker.terminate();
  return out;
}

async function runVoice(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('#screen .hero', { timeout: 120000 });
  const r = await page.evaluate(voiceInPage, { speech: synthSpeech(), reps: 10 });
  await ctx.close();
  const pack = (name) => ({ duracion_s: r[name].duracion_s, texto: r[name].texto, primera_llamada_ms: r[`${name}_primera_llamada_ms`],
    ms_worker: summarize(r[name].ms_worker), ms_pared: summarize(r[name].ms_pared) });
  return { modelo: 'Whisper base cuantizado q8 · transformers.js · onnxruntime-web WASM (worker de la app)', crossOriginIsolated: r.crossOriginIsolated,
    carga_modelo_ms: r.loadMs, repeticiones: 10, segmento_vad: pack('segmento_vad'), clip_completo: pack('clip_completo') };
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); const k = (s.length - 1) * p; const f = Math.floor(k); return s[f] + (s[Math.min(f + 1, s.length - 1)] - s[f]) * (k - f); };
const summarize = (a) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), media: a.reduce((x, y) => x + y, 0) / a.length, min: Math.min(...a), max: Math.max(...a) });

async function run(browser, { label, strip, w, h }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    const m = u.pathname.match(/^\/__bench\/(.+\.png)$/);
    if (m) return route.fulfill({ path: join(FACES, m[1]), contentType: 'image/png' });
    if (!strip) return route.continue();
    const r = await route.fetch();
    const headers = { ...r.headers() };
    delete headers['cross-origin-opener-policy'];
    delete headers['cross-origin-embedder-policy'];
    return route.fulfill({ response: r, headers });
  });
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(url);
  await page.waitForSelector('#screen .hero', { timeout: 120000 }); // the app has finished loading its models
  const r = await page.evaluate(inPage, { names: SCENES, marta: MARTA, n: N, warmup: WARMUP, w, h });
  await ctx.close();
  const threads = r.crossOriginIsolated ? Math.min(4, r.hardwareConcurrency || 1) : 1; // same rule as models.ts
  const etapas = Object.fromEntries(Object.entries(r.per).map(([k, v]) => [k, summarize(v)]));
  const control = Object.fromEntries(Object.entries(r.control).map(([k, v]) => [k, {
    cuadros: v.length, s_max_media: v.reduce((a, b) => a + b[0], 0) / v.length,
    candidata_marta: v.filter((x) => x[1] === 'Marta').length / v.length, calidad_ok: v.filter((x) => x[2]).length / v.length,
  }]));
  return { variante: label, cuadro: r.cuadro, crossOriginIsolated: r.crossOriginIsolated, hilos_wasm: threads,
    hardwareConcurrency: r.hardwareConcurrency, carga_modelos_ms: r.loadMs, galeria: r.galleryN,
    cuadros_medidos: N, cuadros_descartados_warmup: WARMUP, etapas_ms: etapas, total_ms: summarize(r.totals),
    control_por_escena: control, userAgent: r.userAgent };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const cpu = (() => { try { return execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim(); } catch { return cpus()[0]?.model; } })();
const out = { entorno: { cpu, sistema: `${platform()} ${release()}`, chrome: browser.version(), carga_inicial: loadavg() }, variantes: [] };
try {
  for (const v of [
    { label: 'aislado (COOP/COEP) · 1280×720', strip: false, w: 1280, h: 720 },
    { label: 'sin aislamiento · 1280×720', strip: true, w: 1280, h: 720 },
    { label: 'aislado (COOP/COEP) · 640×480', strip: false, w: 640, h: 480 },
  ]) {
    const r = await run(browser, v);
    out.variantes.push(r);
    console.log(`\n${r.variante} · isolated=${r.crossOriginIsolated} · threads=${r.hilos_wasm} · gallery ${r.galeria} · models ${r.carga_modelos_ms.toFixed(0)} ms`);
    for (const [k, s] of Object.entries({ ...r.etapas_ms, TOTAL: r.total_ms })) console.log(`  ${k.padEnd(18)} p50 ${s.p50.toFixed(2).padStart(8)}  p95 ${s.p95.toFixed(2).padStart(8)}  mean ${s.media.toFixed(2).padStart(8)} ms`);
  }
  out.voz = await runVoice(browser);
  const v = out.voz;
  console.log(`\nWeb voice (${v.modelo}) · load ${v.carga_modelo_ms.toFixed(0)} ms`);
  for (const k of ['segmento_vad', 'clip_completo']) console.log(`  ${k.padEnd(14)} ${v[k].duracion_s.toFixed(2)} s · «${v[k].texto}» · p50 ${v[k].ms_worker.p50.toFixed(0)} ms · p95 ${v[k].ms_worker.p95.toFixed(0)} ms`);
} finally {
  await browser.close();
  stop();
}
out.entorno.carga_final = loadavg();
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\nReport written to ${OUT}`);
