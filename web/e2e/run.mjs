// End-to-end test with headless Chrome and a fake camera and microphone:
//   1) enrollment of «Marta» with consent → must say «Es Marta, tu hija.»
//   2) frontal face that is not enrolled → «No es nadie conocido…», never a name
//   3) Marta and then another person without leaving the frame → speaks again when the face changes
//   4) «on request only» mode + microphone: say «¿Quién es?» (local Whisper) → answers with the name
// Requirements: `npm run dev` running on :5173, fixtures generated with e2e/make_fixtures.py,
// Google Chrome installed (or CHROME=/path/to/binary).
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
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok · ${msg}`);
};

const external = new Set();
rmSync(join(DIR, 'profile'), { recursive: true, force: true });

await withCamera('marta', async (p) => {
  await p.click('#screen [data-act=invite]');
  await p.click('#go');
  await p.click('#accept');
  for (let i = 0; i < 200; i++) {
    const hint = await p.textContent('#cap-hint').catch(() => null);
    if (hint === null) break;
    if (/Girá/.test(hint)) await p.click('#skip').catch(() => {}); // a still photo can't turn its head
    await p.waitForTimeout(200);
  }
  await p.fill('#f-name', 'Marta');
  await p.fill('#f-rel', 'tu hija');
  await p.fill('#f-ctx', 'vive en Rosario');
  await p.click('#save');
  await p.click('#try'); // the «done» screen → try it now
  await p.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 30000 });
  const spoken = await p.evaluate(() => window.__spoken);
  assert(spoken[0] === 'Es Marta, tu hija.', `recognizes the enrolled person (${JSON.stringify(spoken)})`);
  await p.screenshot({ path: join(DIR, 'afirmacion.png') });
});

const UNKNOWN = 'No es nadie conocido. Podés invitarlo a sumarse al círculo.';

await withCamera('other', async (p) => {
  await p.waitForTimeout(8000);
  const spoken = await p.evaluate(() => window.__spoken);
  assert(spoken.length >= 1 && spoken.every((s) => s === UNKNOWN), `does not name someone who is not enrolled, and says so (${JSON.stringify(spoken)})`);
  await p.screenshot({ path: join(DIR, 'no-enrolado.png') });
});

await withCamera('change', async (p) => {
  await p.waitForFunction((u) => window.__spoken.includes(u), UNKNOWN, { timeout: 30000 });
  const spoken = await p.evaluate(() => window.__spoken);
  assert(spoken[0] === 'Es Marta, tu hija.' && spoken.includes(UNKNOWN), `speaks again when the face changes (${JSON.stringify(spoken)})`);
});

await withCamera('marta', async (p) => {
  await p.click('.tabs button[data-tab=ajustes]');
  await p.click('.seg[data-seg=mode] button[data-v=demand]');
  await p.click('#mic');
  await p.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 90000 });
  const spoken = await p.evaluate(() => window.__spoken);
  const heard = await p.textContent('#mic-hint');
  assert(spoken[0] === 'Es Marta, tu hija.', `answers «¿Quién es?» by voice (heard ${heard}; said ${JSON.stringify(spoken)})`);
  await p.screenshot({ path: join(DIR, 'voz.png') });
}, 'quien.wav');

assert(external.size === 0, `no requests to other origins (${[...external].join(', ') || 'none'})`);
