// Copia los modelos ONNX a public/ para servirlos desde el mismo origen: la app no hace ninguna petición a terceros (RN-05).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
console.log('Modelos copiados a public/models');
