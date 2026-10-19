// Latencia del pipeline web (onnxruntime-web WASM) en Chrome headless.
//
// Levanta su propio Vite (puerto BENCH_PORT, 5311 por omisión), abre la app e importa los módulos de Vite dentro de la
// página (`await import('/src/pipeline/pipeline.ts')`) para medir `Pipeline.process` sobre cuadros dibujados en un
// canvas a partir de los rostros sintéticos de assets/faces (servidos con page.route, sin tocar web/public).
// La galería (IndexedDB real de la página) tiene 50 identidades: Marta (5 tomas) y 49 plantillas aleatorias.
// Se repite con y sin aislamiento de origen cruzado: el segundo caso quita COOP/COEP de las respuestas, así
// `crossOriginIsolated` queda en false y models.ts usa 1 hilo de WASM en vez de min(4, núcleos).
// Uso:  node e2e/bench.mjs [cuadros=200] [salida=../docs/eval/latencia_web.json]
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

// --- servidor de Vite aislado (como scripts/e2e.sh) ---------------------------------------------
execFileSync('node', ['scripts/copy-assets.mjs'], { cwd: WEB, stdio: 'ignore' });
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: WEB, stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-vite.pid); } catch {} }; // grupo entero: npx deja a vite como hijo
process.on('exit', stop);
const url = `http://localhost:${PORT}/`;
for (let i = 0; i < 120; i++) {
  if (await fetch(url).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}

// --- código que corre dentro de la página ---------------------------------------------------------
async function inPage({ names, marta, n, warmup, w, h }) {
  const { Pipeline } = await import('/src/pipeline/pipeline.ts');
  const gallery = await import('/src/store/gallery.ts');
  const { centroid, l2normalize } = await import('/src/pipeline/models.ts');

  let t0 = performance.now();
  const pipe = await Pipeline.load();
  const loadMs = performance.now() - t0;

  const imgs = {};
  for (const name of names) imgs[name] = await createImageBitmap(await (await fetch(`/__bench/${name}.png`)).blob());

  // PRNG con semilla (mulberry32): mismos cuadros en las dos variantes.
  let seed = 12345;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const FACE = [625, 400]; // centro aproximado del rostro en las imágenes de 1200×896
  const draw = (img, jitter) => {
    const s = (w / img.width) * (jitter ? 1 + rnd() * 0.17 : 1.15);
    const tx = Math.min(0, Math.max(w - img.width * s, w / 2 - FACE[0] * s + (jitter ? (rnd() * 120 - 60) : 0)));
    const ty = Math.min(0, Math.max(h - img.height * s, h / 2 - FACE[1] * s + (jitter ? (rnd() * 120 - 60) : 0)));
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  // Galería de 50: Marta con sus 5 tomas reales + 49 plantillas aleatorias normalizadas.
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
    res.timings.decision_y_resto = Math.max(0, total - sum); // engine.step, getIdentity y esperas entre etapas
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

// --- voz: Whisper base cuantizado (transformers.js, WASM) en el worker de la app --------------------------------
// Frase «¿Quién es?» con la voz del sistema (como e2e/make_fixtures.py). El segmento imita lo que entrega el VAD de
// listener.ts: 320 ms de pre-roll + frase + 700 ms de silencio final. Se mide también el clip completo de 6 s del e2e.
function synthSpeech() {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-voz-'));
  execFileSync('say', ['-v', 'Eddy (Español (México))', '-o', join(dir, 'q.aiff'), '¿Quién es?']);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'q.aiff'), join(dir, 'q.wav')]);
  const buf = readFileSync(join(dir, 'q.wav'));
  const i = buf.indexOf('data') + 8; // cabecera mínima de afconvert: «data» + tamaño de 4 bytes
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
    for (let k = 0; k < reps + 1; k++) { // la primera llamada se descarta (warm-up) y se informa aparte
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
  await page.waitForSelector('#screen .hero', { timeout: 120000 }); // la app terminó de cargar sus modelos
  const r = await page.evaluate(inPage, { names: SCENES, marta: MARTA, n: N, warmup: WARMUP, w, h });
  await ctx.close();
  const threads = r.crossOriginIsolated ? Math.min(4, r.hardwareConcurrency || 1) : 1; // misma regla que models.ts
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
    console.log(`\n${r.variante} · isolated=${r.crossOriginIsolated} · hilos=${r.hilos_wasm} · galería ${r.galeria} · modelos ${r.carga_modelos_ms.toFixed(0)} ms`);
    for (const [k, s] of Object.entries({ ...r.etapas_ms, TOTAL: r.total_ms })) console.log(`  ${k.padEnd(18)} p50 ${s.p50.toFixed(2).padStart(8)}  p95 ${s.p95.toFixed(2).padStart(8)}  media ${s.media.toFixed(2).padStart(8)} ms`);
  }
  out.voz = await runVoice(browser);
  const v = out.voz;
  console.log(`\nVoz web (${v.modelo}) · carga ${v.carga_modelo_ms.toFixed(0)} ms`);
  for (const k of ['segmento_vad', 'clip_completo']) console.log(`  ${k.padEnd(14)} ${v[k].duracion_s.toFixed(2)} s · «${v[k].texto}» · p50 ${v[k].ms_worker.p50.toFixed(0)} ms · p95 ${v[k].ms_worker.p95.toFixed(0)} ms`);
} finally {
  await browser.close();
  stop();
}
out.entorno.carga_final = loadavg();
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\nReporte en ${OUT}`);
