// Copia los modelos ONNX a public/ para servirlos desde el mismo origen: la app no hace ninguna petición a terceros (RN-05).
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const models = join(root, '..', 'models');

mkdirSync(join(root, 'public', 'models'), { recursive: true });

for (const m of ['det_500m.onnx', 'w600k_mbf.onnx']) {
  const src = join(models, m);
  if (!existsSync(src)) {
    console.error(`Falta ${src}. Ejecutá ../scripts/download_models.sh`);
    process.exit(1);
  }
  copyFileSync(src, join(root, 'public', 'models', m));
}
// Whisper (opcional): habilita «¿quién es?» por voz, transcripto en el dispositivo.
const whisper = join(models, 'whisper-base');
if (existsSync(whisper)) cpSync(whisper, join(root, 'public', 'models', 'whisper-base'), { recursive: true });
else console.warn('Sin models/whisper-base: la escucha por voz queda deshabilitada (ver scripts/download_models.sh)');
console.log('Modelos copiados a public/models');
