import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// COOP/COEP habilitan SharedArrayBuffer ⇒ WASM multihilo para onnxruntime-web.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// `npm run dev:phone` sirve por HTTPS en la red local: getUserMedia exige contexto seguro
// para usar la cámara del teléfono.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'phone' ? [basicSsl()] : [],
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
}));
