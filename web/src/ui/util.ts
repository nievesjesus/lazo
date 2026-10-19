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

/** The operating system's TTS. Local voices are preferred: the browser's «online» voices would send the text to a server. */
export function speak(text: string, enabled = true) {
  // The event lets another destination (e.g. a native bridge to the glasses' speaker) receive the phrase.
  window.dispatchEvent(new CustomEvent('mnemo:speak', { detail: text }));
  if (!enabled || !('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('es') && v.localService);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-AR';
  u.rate = 0.95;
  u.voice = voices.find((v) => v.lang === 'es-AR') ?? voices.find((v) => v.lang === 'es-419') ?? voices[0] ?? null;
  if (!u.voice) return; // no local voice: stay silent rather than leak the text to the cloud
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** Counts requests to origins other than our own (the «0 outgoing connections» indicator). */
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
