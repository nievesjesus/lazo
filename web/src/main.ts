import './style.css';

import { Pipeline } from './pipeline/pipeline';
import { App } from './ui/app';

async function main() {
  const msg = document.getElementById('boot-msg')!;
  try {
    const t = performance.now();
    const pipe = await Pipeline.load();
    msg.textContent = `Modelos listos en ${Math.round(performance.now() - t)} ms`;
    await new App(document.getElementById('app')!, pipe).start();
  } catch (e) {
    console.error(e);
    msg.textContent = `Error al iniciar: ${(e as Error).message}`;
  }
}

main();
