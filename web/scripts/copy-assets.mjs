// Copies the ONNX models to public/ so they are served from the same origin: the app makes no requests to third parties.
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const models = join(root, '..', 'models');

mkdirSync(join(root, 'public', 'models'), { recursive: true });

for (const m of ['det_500m.onnx', 'w600k_mbf.onnx']) {
  const src = join(models, m);
  if (!existsSync(src)) {
    console.error(`Missing ${src}. Run ../scripts/download_models.sh`);
    process.exit(1);
  }
  copyFileSync(src, join(root, 'public', 'models', m));
}
// Whisper (optional): enables the «¿quién es?» voice command, transcribed on the device.
const whisper = join(models, 'whisper-base');
if (existsSync(whisper)) cpSync(whisper, join(root, 'public', 'models', 'whisper-base'), { recursive: true });
else console.warn('models/whisper-base not found: voice listening stays disabled (see scripts/download_models.sh)');
console.log('Models copied to public/models');
