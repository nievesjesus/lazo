// Prueba de extremo a extremo con Chrome headless, cámara y micrófono falsos:
//   1) alta con consentimiento de «Marta» → debe decir «Es Marta, tu hija.»
//   2) rostro frontal no enrolado → «No es nadie conocido…», nunca un nombre
//   3) Marta y después otra persona sin salir de cuadro → vuelve a hablar al cambiar la cara
//   4) modo «sólo a pedido» + micrófono: decir «¿Quién es?» (Whisper local) → responde el nombre
// Requisitos: `npm run dev` corriendo en :5173, fixtures generados con e2e/make_fixtures.py,
// Google Chrome instalado (o CHROME=/ruta/al/binario).
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '.tmp');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP_URL = process.env.MNEMO_URL ?? 'http://localhost:5173/';

async function withCamera(cam, fn, audio) {
  const ctx = await chromium.launchPersistentContext(join(DIR, 'profile'), {
    executablePath: CHROME,
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      `--use-file-for-fake-video-capture=${join(DIR, cam)}.y4m`,
      ...(audio ? [`--use-file-for-fake-audio-capture=${join(DIR, audio)}`] : []),
    ],
    viewport: { width: 1400, height: 900 },
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('dialog', (d) => d.accept());
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.origin !== new URL(APP_URL).origin) external.add(u.host); });
  await page.addInitScript(() => {
    window.__spoken = [];
    addEventListener('mnemo:speak', (e) => window.__spoken.push(e.detail));
  });
  await page.goto(APP_URL);
  await page.waitForSelector('#screen .hero', { timeout: 60000 });
  try {
    await fn(page);
  } finally {
    await ctx.close();
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FALLÓ: ${msg}`);
  console.log(`ok · ${msg}`);
};

const external = new Set();
rmSync(join(DIR, 'profile'), { recursive: true, force: true });

await withCamera('marta', async (p) => {
  await p.click('text=+ Invitar a alguien al círculo');
  await p.click('#go');
  await p.click('#accept');
  for (let i = 0; i < 200; i++) {
    const hint = await p.textContent('#cap-hint').catch(() => null);
    if (hint === null) break;
    if (/Girá/.test(hint)) await p.click('#skip').catch(() => {}); // una foto fija no puede girar
    await p.waitForTimeout(200);
  }
  await p.fill('#f-name', 'Marta');
  await p.fill('#f-rel', 'tu hija');
  await p.fill('#f-ctx', 'vive en Rosario');
  await p.click('#save');
  await p.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 30000 });
  const spoken = await p.evaluate(() => window.__spoken);
  assert(spoken[0] === 'Es Marta, tu hija.', `reconoce a la persona enrolada (${JSON.stringify(spoken)})`);
  await p.screenshot({ path: join(DIR, 'afirmacion.png') });
});

const UNKNOWN = 'No es nadie conocido. Podés invitarlo a sumarse al círculo.';

await withCamera('other', async (p) => {
  await p.waitForTimeout(8000);
  const spoken = await p.evaluate(() => window.__spoken);
  assert(spoken.length >= 1 && spoken.every((s) => s === UNKNOWN), `a un no enrolado no lo nombra y lo dice (${JSON.stringify(spoken)})`);
  await p.screenshot({ path: join(DIR, 'no-enrolado.png') });
});

await withCamera('change', async (p) => {
  await p.waitForFunction((u) => window.__spoken.includes(u), UNKNOWN, { timeout: 30000 });
  const spoken = await p.evaluate(() => window.__spoken);
  assert(spoken[0] === 'Es Marta, tu hija.' && spoken.includes(UNKNOWN), `vuelve a hablar al cambiar la cara (${JSON.stringify(spoken)})`);
});

await withCamera('marta', async (p) => {
  await p.click('.tabs button[data-tab=privacidad]');
  await p.click('[data-setting=onDemand]');
  await p.click('[data-setting=listen]');
  await p.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 90000 });
  const spoken = await p.evaluate(() => window.__spoken);
  const heard = await p.getAttribute('#mic', 'title');
  assert(spoken[0] === 'Es Marta, tu hija.', `responde a «¿Quién es?» por voz (oyó ${heard}; dijo ${JSON.stringify(spoken)})`);
  await p.screenshot({ path: join(DIR, 'voz.png') });
}, 'quien.wav');

assert(external.size === 0, `ningún pedido a otros orígenes (${[...external].join(', ') || 'ninguno'})`);
