// On-device transcription with Whisper base (quantized ONNX) via transformers.js.
// The model and runtime are served from our own origin: the audio never leaves the browser.
import { env, pipeline } from '@huggingface/transformers';
// WASM runtime of the onnxruntime-web version that ships with transformers.js (without this it downloads it from a CDN).
import ortMjs from '../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from '../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${import.meta.env.BASE_URL}models/`;
env.backends.onnx.wasm!.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
// The files are already served from our own origin: the transformers.js cache adds nothing and, if it
// ever stored a wrong response (e.g. index.html when the model had not been copied yet), it would keep
// reusing it. It is disabled and any leftover cache is deleted.
env.useBrowserCache = false;
const staleCache = self.caches?.delete('transformers-cache').catch(() => false);

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<Asr> | null = null;

const load = async () => {
  await staleCache;
  // Aggregated model download progress (~77 MB), to show in the UI.
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
      asr = null; // don't stay tied to a failure (e.g. model not copied yet): the next attempt reloads
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
