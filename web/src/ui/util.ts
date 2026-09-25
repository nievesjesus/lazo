export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

export const hhmm = (ts: number) => new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
export const ddmmyyyy = (ts: number) => new Date(ts).toLocaleDateString('es-AR');
export const num = (x: number, d = 2) => x.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const isToday = (ts: number) => new Date(ts).toDateString() === new Date().toDateString();

/** TTS del sistema operativo. Se prefieren voces locales: las voces «en línea» del navegador enviarían el texto a un servidor. */
export function speak(text: string, enabled = true) {
  // El evento permite que otro destino (p. ej. un puente nativo hacia el altavoz de las gafas) reciba la frase.
  window.dispatchEvent(new CustomEvent('mnemo:speak', { detail: text }));
  if (!enabled || !('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('es') && v.localService);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-AR';
  u.rate = 0.95;
  u.voice = voices.find((v) => v.lang === 'es-AR') ?? voices.find((v) => v.lang === 'es-419') ?? voices[0] ?? null;
  if (!u.voice) return; // sin voz local: no se habla antes que filtrar el texto a la nube
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** Cuenta peticiones a orígenes distintos del propio (P-06: «0 conexiones salientes»). */
export function watchEgress(onChange: (n: number, hosts: string[]) => void) {
  const hosts = new Set<string>();
  const check = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      try {
        const u = new URL(e.name);
        if (u.origin !== location.origin && u.protocol.startsWith('http')) hosts.add(u.host);
      } catch { /* data:, blob: */ }
    }
    onChange(hosts.size, [...hosts]);
  };
  check(performance.getEntriesByType('resource'));
  new PerformanceObserver((l) => check(l.getEntries())).observe({ type: 'resource', buffered: true });
}
