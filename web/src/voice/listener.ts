// Escucha «¿quién es?» con el micrófono. Un detector de actividad de voz por energía recorta cada
// frase y sólo esos fragmentos se transcriben con Whisper en un worker. El audio vive en memoria
// durante la transcripción y se descarta (RN-02); nada se envía a la red.

export type ListenerStatus = 'apagado' | 'cargando' | 'escuchando' | 'transcribiendo' | 'error';

const SAMPLE_RATE = 16000;
const FRAME = 1024; // 64 ms
const PREROLL_FRAMES = 5; // ~320 ms antes del inicio detectado
const END_SILENCE_MS = 700;
const MAX_SEGMENT_MS = 4000;
const MIN_SPEECH_MS = 300;

/** «¿quién es?», «¿quién está?», «¿cómo se llama?», «¿quién me habla?», «¿quién era?». */
// Límites de palabra Unicode: \b de JS no reconoce la «á» como letra.
const ASK = /(?<!\p{L})(qui[eé]n\s+(es|est[aá]|era|ser[aá]|me\s+habla|viene)|c[oó]mo\s+se\s+llama)(?!\p{L})/iu;

/** Whisper suele entender «¿Qué es?» cuando se dice «¿Quién es?»: se acepta sólo como frase completa. */
const ASK_SHORT = /^[\s¿¡]*(qu[eé]|qui[eé]n)(\s+es)?[\s?!.]*$/iu;

export function isAsk(text: string): boolean {
  const t = text.normalize('NFC');
  return ASK.test(t) || ASK_SHORT.test(t);
}

export class VoiceListener {
  status: ListenerStatus = 'apagado';
  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private seq = 0;
  /** Mientras devuelva true (p. ej. el TTS está hablando) no se graba, para no transcribir la propia voz. */
  muted: () => boolean = () => false;

  constructor(
    private onAsk: (text: string) => void,
    private onStatus: (s: ListenerStatus, detail?: string) => void,
  ) {}

  private set(s: ListenerStatus, detail?: string) {
    this.status = s;
    this.onStatus(s, detail);
  }

  async start() {
    if (this.ctx) return;
    try {
      await this.open();
    } catch (e) {
      const msg = describe(e);
      this.stop();
      this.worker?.terminate();
      this.worker = null;
      this.set('error', msg);
      throw new Error(msg);
    }
  }

  private async open() {
    this.set('cargando', 'modelo de voz (~77 MB la primera vez)');
    this.worker ??= new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
    const ready = new Promise<void>((resolve, reject) => {
      this.worker!.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') resolve();
        else if (m.type === 'error') {
          reject(new Error(`Whisper: ${m.message}`));
          if (this.status !== 'cargando') this.set('error', `Whisper: ${m.message}`);
        } else if (m.type === 'text') {
          if (this.status === 'transcribiendo') this.set('escuchando', `«${m.text}» · ${m.ms} ms`);
          if (isAsk(m.text)) this.onAsk(m.text);
        }
      };
    });
    ready.catch(() => {}); // si falla el micrófono antes, el error se reporta desde start()
    this.worker.postMessage({ type: 'load' });

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Se captura a la frecuencia nativa del dispositivo y se remuestrea a 16 kHz a mano: pedir un
    // AudioContext de 16 kHz falla en Firefox y en algunos Safari al conectar el micrófono.
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const ratio = this.ctx.sampleRate / SAMPLE_RATE;
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor alcanza para un VAD por energía; evita servir un AudioWorklet aparte.
    const proc = this.ctx.createScriptProcessor(nextPow2(FRAME * ratio), 1, 1);
    src.connect(proc);
    proc.connect(this.ctx.destination);

    const pre: Float32Array[] = [];
    let seg: Float32Array[] | null = null;
    let silentMs = 0, speechMs = 0, floor = 0.005;
    const frameMs = (nextPow2(FRAME * ratio) / (SAMPLE_RATE * ratio)) * 1000;

    proc.onaudioprocess = (ev) => {
      const x = resample(ev.inputBuffer.getChannelData(0), ratio);
      ev.outputBuffer.getChannelData(0).fill(0);
      if (this.muted()) {
        seg = null;
        pre.length = 0;
        return;
      }
      let e = 0;
      for (let i = 0; i < x.length; i++) e += x[i] * x[i];
      const rms = Math.sqrt(e / x.length);
      const speaking = rms > Math.max(0.012, floor * 3);
      if (!speaking) floor = 0.95 * floor + 0.05 * rms; // piso de ruido adaptativo

      if (!seg) {
        pre.push(x);
        if (pre.length > PREROLL_FRAMES) pre.shift();
        if (speaking) {
          seg = [...pre];
          silentMs = 0;
          speechMs = frameMs;
        }
        return;
      }
      seg.push(x);
      if (speaking) {
        silentMs = 0;
        speechMs += frameMs;
      } else silentMs += frameMs;
      const len = seg.length * frameMs;
      if (silentMs >= END_SILENCE_MS || len >= MAX_SEGMENT_MS) {
        const done = seg;
        seg = null;
        pre.length = 0;
        if (speechMs >= MIN_SPEECH_MS) this.transcribe(done);
      }
    };
    await ready;
    this.set('escuchando');
  }

  private transcribe(frames: Float32Array[]) {
    const audio = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) {
      audio.set(f, o);
      o += f.length;
    }
    this.set('transcribiendo');
    this.worker?.postMessage({ type: 'transcribe', id: ++this.seq, audio }, [audio.buffer]);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.set('apagado');
  }
}

const nextPow2 = (n: number) => 2 ** Math.round(Math.log2(n));

/** Remuestreo a 16 kHz promediando cada bloque (filtro de caja como antialiasing básico). */
function resample(input: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-3) return new Float32Array(input);
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let acc = 0;
    for (let j = a; j < b; j++) acc += input[j];
    out[i] = acc / Math.max(1, b - a);
  }
  return out;
}

function describe(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === 'NotAllowedError') return 'Permiso de micrófono denegado: habilitalo en el candado de la barra de direcciones';
  if (err?.name === 'NotFoundError') return 'No se encontró un micrófono';
  if (err?.name === 'NotReadableError') return 'El micrófono está en uso por otra aplicación';
  return err?.message ?? String(e);
}
