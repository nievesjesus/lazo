import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// COOP/COEP enable SharedArrayBuffer ⇒ multithreaded WASM for onnxruntime-web.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// `npm run dev:phone` serves over HTTPS on the local network: getUserMedia requires a secure
// context to use the phone camera.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'phone' ? [basicSsl()] : [],
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
}));
