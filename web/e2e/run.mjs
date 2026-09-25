// Prueba de extremo a extremo con Chrome headless y cámara falsa:
//   1) alta con consentimiento de «Marta» → debe decir «Es Marta, tu hija.»
//   2) rostro frontal no enrolado → no debe decir nada (cuadro descartado)
// Requisitos: `npm run dev` corriendo en :5173, fixtures generados con e2e/make_fixtures.py,
// Google Chrome instalado (o CHROME=/ruta/al/binario).
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '.tmp');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.MNEMO_URL ?? 'http://localhost:5173/';

async function withCamera(cam, fn) {
  const ctx = await chromium.launchPersistentContext(join(DIR, 'profile'), {
    executablePath: CHROME,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${join(DIR, cam)}.y4m`],
    viewport: { width: 1400, height: 900 },
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => {
    window.__spoken = [];
    addEventListener('mnemo:speak', (e) => window.__spoken.push(e.detail));
  });
  await page.goto(URL);
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

await withCamera('other', async (p) => {
  await p.waitForTimeout(8000);
  const spoken = await p.evaluate(() => window.__spoken);
  const state = await p.textContent('#wearer-state');
  assert(spoken.length === 0, `no nombra a un no enrolado (estado: ${state})`);
  await p.screenshot({ path: join(DIR, 'no-enrolado.png') });
});
