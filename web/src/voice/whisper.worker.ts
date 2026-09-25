// Transcripción en el dispositivo con Whisper base (ONNX cuantizado) vía transformers.js.
// El modelo y el runtime se sirven desde el propio origen: el audio nunca sale del navegador (RN-05).
import { env, pipeline } from '@huggingface/transformers';
// Runtime WASM de la versión de onnxruntime-web que trae transformers.js (sin esto lo baja de un CDN).
import ortMjs from '../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from '../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${import.meta.env.BASE_URL}models/`;
env.backends.onnx.wasm!.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
// Los archivos ya se sirven desde el propio origen: la caché de transformers.js no aporta y, si alguna
// vez guardó una respuesta equivocada (p. ej. el index.html cuando el modelo aún no estaba copiado),
// la seguiría reutilizando. Se desactiva y se borra la que haya quedado.
env.useBrowserCache = false;
const staleCache = self.caches?.delete('transformers-cache').catch(() => false);

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<Asr> | null = null;

const load = async () => {
  await staleCache;
  // Progreso agregado de la descarga del modelo (~77 MB), para mostrarlo en la interfaz.
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== 'progress' || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    self.postMessage({ type: 'progress', pct: Math.round((100 * loaded) / total) });
  };
  asr ??= (pipeline('automatic-speech-recognition', 'whisper-base', { dtype: 'q8', device: 'wasm', progress_callback }) as unknown as Promise<Asr>)
    .catch((err) => {
      asr = null; // no quedar atado a un fallo (p. ej. modelo aún no copiado): el próximo intento recarga
      throw err;
    });
  return asr;
};

self.onmessage = async (e: MessageEvent<{ type: 'load' } | { type: 'transcribe'; id: number; audio: Float32Array }>) => {
  try {
    if (e.data.type === 'load') {
      await load();
      self.postMessage({ type: 'ready' });
      return;
    }
    const { id, audio } = e.data;
    const t = performance.now();
    const out = await (await load())(audio, { language: 'spanish', task: 'transcribe' });
    const text = (Array.isArray(out) ? out[0]?.text : out.text) ?? '';
    self.postMessage({ type: 'text', id, text: text.trim(), ms: Math.round(performance.now() - t) });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error).message });
  }
};
