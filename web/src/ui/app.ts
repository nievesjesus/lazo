import { ABSTAIN_BAND, ENROLLMENT, MAX_GALLERY, NOBODY_PHRASE, UNCLEAR_PHRASE } from '../pipeline/config';
import { WebcamSource } from '../pipeline/capture';
import { centroid } from '../pipeline/models';
import type { FrameResult, Pipeline } from '../pipeline/pipeline';
import * as gallery from '../store/gallery';
import * as history from '../store/history';
import { type Calibration, estimate, loadSettings, saveSettings, type Settings } from '../store/settings';
import { type ListenerStatus, VoiceListener } from '../voice/listener';
import { confirmDialog, toast } from './feedback';
import { icon } from './icons';
import { drawFrame } from './live';
import { $, ddmmyyyy, esc, hhmm, initials, isToday, num, speak, watchEgress } from './util';

type Tab = 'inicio' | 'circulo' | 'historial' | 'ajustes';
type ToggleKey = 'onDemand' | 'voice' | 'announceOnChange' | 'announceUnknown' | 'listen' | 'details';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'inicio', label: 'Inicio', icon: 'home' },
  { key: 'circulo', label: 'Círculo', icon: 'users' },
  { key: 'historial', label: 'Historial', icon: 'clock' },
  { key: 'ajustes', label: 'Ajustes', icon: 'sliders' },
];

/** Three safety levels instead of a number: the τ_high for each one. */
const SAFETY = [
  { key: 'rapido', label: 'Rápido', tau: 0.34, text: 'Reconoce enseguida, pero se equivoca de nombre con más frecuencia.' },
  { key: 'equilibrado', label: 'Equilibrado', tau: 0.38, text: 'Recomendado. Casi nunca nombra mal y rara vez se queda callado.' },
  { key: 'prudente', label: 'Prudente', tau: 0.45, text: 'Sólo nombra cuando está muy seguro; a veces calla aunque conozca a la persona.' },
] as const;

const STATE_LABEL: Record<string, string> = {
  en_reposo: 'en reposo', observando: 'observando', afirmando: 'afirmando', absteniendose: 'absteniéndose', descartando: 'descartando',
};

/** Quality reasons in plain words, each with an actionable hint. */
const FRIENDLY: Record<string, string> = {
  'rostro pequeño': 'Está lejos · acercate un poco',
  borroso: 'Imagen movida · quedate quieto un momento',
  'poca luz': 'Hay poca luz',
  sobreexpuesto: 'Demasiada luz de frente',
  'de perfil': 'Está de costado',
  'detección débil': 'No se ve bien la cara',
};

const MIC_LABEL: Record<ListenerStatus, string> = {
  apagado: 'Escuchar', cargando: 'Preparando voz', escuchando: 'Escuchando', transcribiendo: 'Escuchando', error: 'Voz no disponible',
};

export class App {
  private settings!: Settings;
  private source: WebcamSource | null = null;
  private frame = document.createElement('canvas');
  private tab: Tab = 'inicio';
  private running = false;
  private enrolling = false;
  private demand = { until: 0 };
  private egress = 0;
  private lastAnnouncement: { res: FrameResult; at: number } | null = null;
  private fps = 0;
  private discardCounted = false;
  private cameraError: string | null = null;
  private galleryEmpty = true;
  /** «¿Quién es?» awaiting an answer: if it times out with no announcement, explain why (nobody there / face barely visible). */
  private pendingAsk: { at: number; sawFace: boolean } | null = null;
  private listener = new VoiceListener(
    () => this.ask(),
    (s, d) => this.onListenerStatus(s, d),
  );

  constructor(private root: HTMLElement, private pipe: Pipeline) {}

  async start() {
    this.settings = await loadSettings();
    this.applyDecisionSettings();
    this.root.innerHTML = this.shell();
    this.bindShell();
    watchEgress((n) => {
      this.egress = n;
      document.querySelectorAll('[data-egress]').forEach((el) => (el.textContent = String(n)));
    });
    this.galleryEmpty = (await gallery.list()).length === 0;
    await this.renderPhone();
    this.listener.muted = () => 'speechSynthesis' in window && speechSynthesis.speaking;
    this.onListenerStatus('apagado');
    this.syncTopbar();
    if (!this.settings.privacyMode) {
      await this.startCamera();
      if (this.settings.listen) this.startListening();
    } else this.renderPaused();
  }

  // ================================================================ global actions
  /** «¿Quién es?» via button, space bar or voice: a new encounter that always answers. */
  private ask() {
    if (this.settings.privacyMode) return;
    this.pipe.engine.request();
    this.lastAnnouncement = null;
    this.pendingAsk = { at: performance.now(), sawFace: false };
    this.demand.until = performance.now() + 5000;
    const b = document.getElementById('ask');
    b?.classList.add('pulse');
    setTimeout(() => b?.classList.remove('pulse'), 600);
  }

  private async setPaused(paused: boolean) {
    this.settings.privacyMode = paused;
    await saveSettings(this.settings);
    this.pipe.engine.reset();
    this.lastAnnouncement = null;
    if (paused) {
      this.stopCamera();
      this.listener.stop();
      this.renderPaused();
    } else {
      await this.startCamera();
      if (this.settings.listen) this.startListening();
    }
    this.syncTopbar();
    if (this.tab === 'inicio') await this.renderPhone();
  }

  private async setToggle(key: ToggleKey, on: boolean) {
    this.settings[key] = on;
    await saveSettings(this.settings);
    this.applyDecisionSettings();
    if (key === 'onDemand' || key === 'announceOnChange' || key === 'announceUnknown') this.pipe.engine.reset();
    if (key === 'listen') {
      if (on && !this.settings.privacyMode) this.startListening();
      else this.listener.stop();
    }
    this.syncTopbar();
  }

  private syncTopbar() {
    const pause = document.getElementById('pause');
    if (pause) {
      pause.innerHTML = this.settings.privacyMode ? `${icon('play', 18)}<span>Reanudar</span>` : `${icon('pause', 18)}<span>Pausar</span>`;
      pause.classList.toggle('on', this.settings.privacyMode);
    }
    document.getElementById('details')?.classList.toggle('on', this.settings.details);
    const mic = document.getElementById('mic');
    mic?.setAttribute('aria-pressed', String(this.settings.listen));
  }

  private startListening() {
    this.listener.start().catch(() => { /* the error state is already shown */ });
  }

  private onListenerStatus(s: ListenerStatus, detail?: string) {
    const btn = document.getElementById('mic');
    if (btn) {
      btn.className = `mic-btn ${s}`;
      const label = s === 'cargando' && detail ? `${MIC_LABEL[s]} ${detail}` : MIC_LABEL[s];
      btn.innerHTML = `${icon(s === 'error' ? 'micOff' : 'mic', 18)}<span>${label}</span>`;
    }
    const hint = document.getElementById('mic-hint');
    if (hint) {
      hint.className = `hint ${s === 'error' ? 'err' : ''}`;
      hint.textContent =
        s === 'escuchando' || s === 'transcribiendo' ? 'Decí «¿Quién es?»' + (detail?.startsWith('«') ? ` · oí ${detail.split(' · ')[0]}` : '')
        : s === 'cargando' ? 'La primera vez descarga el modelo de voz (~77 MB); después funciona sin internet.'
        : s === 'error' ? (detail ?? '')
        : '';
    }
  }

  // ================================================================ camera and loop
  private async startCamera() {
    this.source?.stop();
    this.cameraError = null;
    this.setStatus('Encendiendo la cámara…', 'idle');
    this.source = new WebcamSource(this.settings.facing);
    try {
      await this.source.start();
    } catch (e) {
      const err = e as { name?: string; message?: string };
      this.cameraError = err.name === 'NotAllowedError'
        ? 'Permití el acceso a la cámara desde el candado de la barra de direcciones y recargá la página.'
        : err.name === 'NotFoundError' ? 'No se encontró ninguna cámara.'
        : err.name === 'NotReadableError' ? 'La cámara está en uso por otra aplicación.'
        : err.message ?? 'No se pudo abrir la cámara.';
      this.setStatus('Sin cámara', 'idle');
      this.renderOverlay();
      return;
    }
    this.renderOverlay();
    this.running = true;
    this.loop();
  }

  private stopCamera() {
    this.running = false;
    this.source?.stop();
  }

  private applyDecisionSettings() {
    const c = this.pipe.engine.cfg;
    c.tauHigh = this.settings.tauHigh;
    c.tauLow = Math.max(0, this.settings.tauHigh - ABSTAIN_BAND);
    c.dwellMs = this.settings.onDemand ? 0 : this.settings.dwellMs;
    c.announceOnChange = this.settings.announceOnChange;
    c.announceUnknown = this.settings.announceUnknown;
  }

  private async loop() {
    const canvas = $<HTMLCanvasElement>('#wearer-canvas');
    let last = performance.now();
    while (this.running && this.source) {
      if (this.enrolling) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (!this.source.grab(this.frame)) {
        await new Promise((r) => requestAnimationFrame(r));
        continue;
      }
      const now = performance.now();
      const active = !this.settings.onDemand || now < this.demand.until;
      let res: FrameResult | null = null;
      if (active) {
        res = await this.pipe.process(this.frame, now);
        await this.onResult(res);
      }
      this.checkPendingAsk(res, now);
      drawFrame(canvas, this.frame, res, this.settings.facing === 'user', this.settings.details);
      this.renderWearer(res, active);
      this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, performance.now() - last));
      last = performance.now();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  private async onResult(res: FrameResult) {
    if (res.state === 'en_reposo') this.discardCounted = false;
    if (res.state === 'descartando' && !this.discardCounted) {
      await history.countDiscard(); // only an anonymous event in the day's counter
      this.discardCounted = true;
    }
    const ann = res.announcement;
    if (!ann || !res.phrase) return;
    this.pendingAsk = null;
    this.lastAnnouncement = { res, at: performance.now() };
    speak(res.phrase, this.settings.voice);
    this.showEar(res.phrase, ann.kind !== 'match');
    if (this.settings.onDemand) this.demand.until = 0;
    // Without permission to log encounters, the announcement is recorded without an identity.
    const consented = !!res.identity?.consent.encounterLog;
    await history.log({
      ts: Date.now(),
      kind: ann.kind === 'match' ? 'aviso' : ann.kind === 'abstain' ? 'abstencion' : 'desconocido',
      identityId: consented ? ann.identityId : null,
      similarity: ann.sMax,
      latencyMs: ann.latencyMs,
      hits: `${ann.hits}/${ann.window}`,
    });
    if (this.tab === 'inicio' || this.tab === 'historial') await this.renderPhone();
  }

  private checkPendingAsk(res: FrameResult | null, now: number) {
    const p = this.pendingAsk;
    if (!p) return;
    if (res?.face) p.sawFace = true;
    if (now - p.at < 2500) return;
    this.pendingAsk = null;
    const phrase = p.sawFace ? UNCLEAR_PHRASE : NOBODY_PHRASE;
    speak(phrase, this.settings.voice);
    this.showEar(phrase, true);
  }

  // ================================================================ wearer view
  private setStatus(text: string, tone: 'ok' | 'warn' | 'idle' | 'live') {
    const el = document.getElementById('status');
    if (!el) return;
    el.className = `status-pill ${tone}`;
    $('#status-text').textContent = text;
  }

  private showEar(phrase: string, soft = false) {
    const ear = $('#ear');
    ear.classList.toggle('soft', soft);
    ear.classList.add('show');
    $('#ear-text').textContent = `«${phrase}»`;
    clearTimeout((ear as HTMLElement & { _t?: number })._t);
    (ear as HTMLElement & { _t?: number })._t = window.setTimeout(() => ear.classList.remove('show'), 5000);
  }

  private renderWearer(res: FrameResult | null, active: boolean) {
    const a = this.lastAnnouncement;
    const fresh = a && performance.now() - a.at < 6000 ? a : null;
    const card = $('#card');
    const cfg = this.pipe.engine.cfg;

    if (fresh) {
      const r = fresh.res;
      const ann = r.announcement!;
      if (ann.kind === 'match' && r.identity) {
        this.setStatus(`Es ${r.identity.name}`, 'ok');
        card.innerHTML = `<h2>${esc(r.identity.name)}</h2><p>${esc(r.identity.relation)}${r.identity.context ? ` · ${esc(r.identity.context)}` : ''}</p>`;
      } else if (ann.kind === 'unknown') {
        this.setStatus('No es nadie conocido', 'warn');
        card.innerHTML = `<h2>No es nadie conocido</h2><p>Podés invitarlo a sumarse al círculo.</p>`;
      } else {
        this.setStatus('No estoy seguro', 'warn');
        card.innerHTML = `<h2>No estoy seguro</h2><p>Prefiero no decir un nombre. Podés preguntarle cómo se llama.</p>`;
      }
      if (this.settings.details) {
        card.innerHTML += `<div class="meta">similitud ${num(ann.sMax)} · ${ann.hits} de ${ann.window} cuadros · τ ${num(cfg.tauLow)}–${num(cfg.tauHigh)} · ${Math.round(ann.latencyMs)} ms · ${ann.reason}</div>`;
      }
    } else {
      card.innerHTML = '';
      const last = this.lastAnnouncement?.res;
      // While it is still the same person (encounter already announced), their name stays in the status.
      const same = this.pipe.engine.announced && last?.announcement && res?.face;
      if (same && last.announcement!.kind === 'match' && last.identity) this.setStatus(last.identity.name, 'ok');
      else if (same && last.announcement!.kind === 'unknown') this.setStatus('No es nadie conocido', 'idle');
      else if (same) this.setStatus('No estoy seguro', 'idle');
      else if (this.settings.onDemand && !active) this.setStatus('Esperando que preguntes', 'idle');
      else if (!res?.face) this.setStatus('Buscando caras', 'live');
      else if (res.quality && !res.quality.ok) this.setStatus(FRIENDLY[res.quality.reason ?? ''] ?? 'No se ve bien la cara', 'idle');
      else this.setStatus('Reconociendo…', 'live');
    }

    const tech = $('#tech');
    tech.textContent = this.settings.details
      ? `${STATE_LABEL[this.pipe.engine.state]} · ${num(this.fps, 0)} fps` + (res?.sMax !== undefined && res.sMax > -1 ? ` · mejor ${num(res.sMax)} · τ ${num(cfg.tauHigh)}` : '')
      : '';
  }

  /** Video overlay: empty circle, camera without permission, or paused. */
  private renderOverlay() {
    const el = $('#overlay');
    if (this.settings.privacyMode) {
      el.innerHTML = `<div class="overlay-card">${icon('pause', 28)}<h3>En pausa</h3><p>La cámara y los avisos están apagados. No se captura nada.</p><button class="btn light" data-act="resume">Reanudar</button></div>`;
    } else if (this.cameraError) {
      el.innerHTML = `<div class="overlay-card">${icon('camera', 28)}<h3>No hay acceso a la cámara</h3><p>${esc(this.cameraError)}</p><button class="btn light" data-act="retry-camera">Reintentar</button></div>`;
    } else if (this.galleryEmpty && !this.enrolling) {
      el.innerHTML = `<div class="overlay-card">${icon('userPlus', 28)}<h3>Todavía no hay nadie en el círculo</h3><p>Agregá a una persona de confianza y la próxima vez que la veas te lo digo al oído.</p><button class="btn light" data-act="invite">Agregar a alguien</button></div>`;
    } else {
      el.innerHTML = '';
    }
    el.classList.toggle('show', !!el.innerHTML);
  }

  private renderPaused() {
    const c = $<HTMLCanvasElement>('#wearer-canvas');
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, c.width, c.height);
    this.setStatus('En pausa', 'idle');
    $('#card').innerHTML = '';
    $('#tech').textContent = '';
    this.renderOverlay();
  }

  // ================================================================ structure
  private shell() {
    return `
    <header class="topbar">
      <div class="brand"><span class="logo">L</span><div><strong>Lazo</strong><small>Te dice al oído quién tenés enfrente</small></div></div>
      <nav class="switch" aria-label="Vista">
        <button data-view="wearer" class="on">${icon('glasses', 18)}<span>Gafas</span></button>
        <button data-view="phone">${icon('users', 18)}<span>Cuidador</span></button>
      </nav>
      <div class="top-actions">
        <button id="details" class="icon-btn" title="Detalles técnicos" aria-label="Detalles técnicos">${icon('code', 18)}</button>
        <button id="pause" class="pill-btn"></button>
      </div>
    </header>
    <main class="stage" data-view="wearer">
      <section class="wearer" aria-label="Lo que percibe quien usa las gafas">
        <div class="section-label">${icon('glasses', 16)} Lo que percibe quien usa las gafas</div>
        <div class="viewport">
          <canvas id="wearer-canvas" width="1280" height="720"></canvas>
          <div class="hud-top"><span id="status" class="status-pill idle"><i></i><span id="status-text">Cargando…</span></span><span id="tech" class="tech"></span></div>
          <div id="overlay" class="overlay"></div>
          <div class="hud-bottom">
            <div id="card" class="card-id" aria-live="polite"></div>
            <div id="ear" class="ear">${icon('speaker', 18)}<div><small>Al oído</small><div id="ear-text"></div></div></div>
          </div>
        </div>
        <div class="controls">
          <button id="ask" class="btn big">${icon('question', 22)}<span>¿Quién es?</span></button>
          <button id="mic" class="mic-btn" aria-pressed="false"></button>
          <span id="mic-hint" class="hint"></span>
        </div>
        <p class="footnote">En las gafas no hay pantalla: la persona sólo escucha la frase. Atajo: barra espaciadora.</p>
      </section>
      <section class="phone" aria-label="App del cuidador">
        <div class="section-label">${icon('users', 16)} App del cuidador</div>
        <div class="device"><div id="screen" class="screen"></div>
          <nav class="tabs">${TABS.map((t) => `<button data-tab="${t.key}">${icon(t.icon, 22)}<span>${t.label}</span></button>`).join('')}</nav>
        </div>
      </section>
    </main>`;
  }

  private setView(view: 'wearer' | 'phone') {
    $('.stage').dataset.view = view;
    this.root.querySelectorAll<HTMLElement>('.switch button').forEach((x) => x.classList.toggle('on', x.dataset.view === view));
  }

  private bindShell() {
    this.root.querySelectorAll<HTMLButtonElement>('.switch button').forEach((b) =>
      b.addEventListener('click', () => this.setView(b.dataset.view as 'wearer' | 'phone')));
    this.root.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
      b.addEventListener('click', () => { this.tab = b.dataset.tab as Tab; this.renderPhone(); }));
    $('#ask').addEventListener('click', () => this.ask());
    $('#mic').addEventListener('click', async () => {
      await this.setToggle('listen', !this.settings.listen);
      if (this.tab === 'ajustes') await this.renderPhone();
    });
    $('#pause').addEventListener('click', () => this.setPaused(!this.settings.privacyMode));
    $('#details').addEventListener('click', async () => {
      await this.setToggle('details', !this.settings.details);
      if (this.tab === 'ajustes') await this.renderPhone();
    });
    $('#overlay').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'invite') this.enroll();
      if (b.dataset.act === 'resume') this.setPaused(false);
      if (b.dataset.act === 'retry-camera') this.startCamera();
    });
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(t.tagName)) {
        e.preventDefault();
        this.ask();
      }
    });
  }

  // ================================================================ caregiver app
  private async renderPhone() {
    if (this.enrolling) return;
    this.galleryEmpty = (await gallery.list()).length === 0;
    this.renderOverlay();
    this.root.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const screen = $('#screen');
    screen.innerHTML = await ({
      inicio: () => this.screenHome(),
      circulo: () => this.screenCircle(),
      historial: () => this.screenHistory(),
      ajustes: () => this.screenSettings(),
    })[this.tab]();
    screen.scrollTop = 0;
    this.bindScreen(screen);
  }

  private async screenHome() {
    const [ids, enc] = await Promise.all([gallery.list(), history.recent()]);
    const today = enc.filter((e) => isToday(e.ts));
    const recognized = today.filter((e) => e.kind === 'aviso').length;
    const unknown = today.length - recognized;
    const hour = new Date().getHours();
    const hello = hour < 13 ? 'Buen día' : hour < 20 ? 'Buenas tardes' : 'Buenas noches';
    const status = this.settings.privacyMode
      ? `<p class="hero-status idle">${icon('pause', 16)} En pausa · no se captura nada</p>`
      : `<p class="hero-status">${icon('shield', 16)} Funciona sólo en este dispositivo</p>`;

    if (!ids.length) {
      return `
        <div class="hero"><h1>${hello}</h1>${status}</div>
        <div class="pad">
          <div class="onboard">
            <h2>Empecemos</h2>
            <ol class="steps-big">
              <li><b>Invitá a alguien de confianza.</b><span>Un familiar, un amigo, quien los cuida.</span></li>
              <li><b>Esa persona acepta y se saca 5 fotos.</b><span>Las fotos no se guardan: sólo un código cifrado.</span></li>
              <li><b>Listo.</b><span>Cuando la veas, te digo al oído quién es.</span></li>
            </ol>
            <button class="btn block big" data-act="invite">${icon('userPlus', 20)} Agregar a la primera persona</button>
          </div>
        </div>`;
    }
    return `
      <div class="hero"><h1>${hello}</h1>${status}</div>
      <div class="pad">
        <div class="stats">
          <div><b>${ids.length}</b><span>en el círculo</span></div>
          <div><b>${recognized}</b><span>reconocidos hoy</span></div>
          <div><b>${unknown}</b><span>sin reconocer hoy</span></div>
        </div>
        <div class="panel">
          <div class="panel-h"><h3>Hoy</h3>${today.length ? '<button class="link" data-go="historial">Ver todo</button>' : ''}</div>
          ${today.length ? this.timeline(today.slice(0, 6), ids, false) : '<p class="empty">Todavía no hubo encuentros hoy.</p>'}
        </div>
        <button class="btn block ghost" data-act="invite" ${ids.length >= MAX_GALLERY ? 'disabled' : ''}>${icon('userPlus', 20)} Agregar persona</button>
      </div>`;
  }

  /** List of encounters; consecutive unrecognized ones are grouped into a single row. */
  private timeline(list: history.Encounter[], ids: gallery.Identity[], withReport: boolean) {
    const out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.kind !== 'aviso') {
        let j = i;
        while (j + 1 < list.length && list[j + 1].kind !== 'aviso') j++;
        const n = j - i + 1;
        const label = n > 1 ? `${n} personas sin reconocer` : e.kind === 'abstencion' ? 'No estaba seguro' : 'No era nadie conocido';
        const when = n > 1 ? `${hhmm(list[j].ts)} – ${hhmm(e.ts)}` : hhmm(e.ts);
        out.push(this.row('?', label, n > 1 ? 'No se guardó nada de estas caras' : 'No se guardó nada de esa cara', when, 'ghost', ''));
        i = j;
        continue;
      }
      const ident = ids.find((x) => x.id === e.identityId);
      const tech = this.settings.details ? ` · s ${num(e.similarity)} · ${Math.round(e.latencyMs)} ms` : '';
      const report = withReport ? (e.reportedError ? '<span class="tag warn">Marcado como error</span>' : `<button class="link small" data-report="${e.ts}">¿Se equivocó?</button>`) : '';
      out.push(ident
        ? this.row(initials(ident.name), `${esc(ident.name)}`, `${esc(ident.relation)}${tech}`, hhmm(e.ts), '', report)
        : this.row('·', 'Alguien del círculo', `Sin permiso para registrar el nombre${tech}`, hhmm(e.ts), 'soft', report));
    }
    return `<div class="rows">${out.join('')}</div>`;
  }

  private row(avatar: string, title: string, sub: string, right: string, tone: string, extra: string) {
    return `<div class="row"><span class="avatar ${tone}">${avatar}</span><div class="grow"><b>${title}</b><small>${sub}</small>${extra ? `<div class="row-extra">${extra}</div>` : ''}</div><span class="time">${right}</span></div>`;
  }

  private async screenCircle() {
    const ids = await gallery.list();
    const soon = Date.now() + 30 * 24 * 3600 * 1000;
    return `
      <div class="hero"><h1>Círculo de confianza</h1><p>${ids.length ? `${ids.length} ${ids.length === 1 ? 'persona' : 'personas'} · hasta ${MAX_GALLERY}` : 'Nadie todavía'}</p></div>
      <div class="pad">
        ${ids.length ? `<div class="panel rows">${ids.map((i) => {
          const chip = gallery.isExpired(i) ? '<span class="tag warn">Venció el permiso</span>'
            : i.expiresAt < soon ? '<span class="tag warn">Vence pronto</span>'
            : gallery.isWeak(i) ? '<span class="tag soft">Rehacer fotos</span>' : '';
          return `<button class="row link-row" data-person="${i.id}"><span class="avatar">${initials(i.name)}</span><div class="grow"><b>${esc(i.name)}</b><small>${esc(i.relation)}</small></div>${chip}${icon('chevron', 18)}</button>`;
        }).join('')}</div>`
        : `<div class="empty-block">${icon('users', 32)}<p>Agregá a las personas que la persona que usa las gafas ve seguido.</p></div>`}
        <button class="btn block" data-act="invite" ${ids.length >= MAX_GALLERY ? 'disabled' : ''}>${icon('userPlus', 20)} Agregar persona</button>
        <p class="footnote center">Nadie puede ser agregado sin estar presente y aceptar desde su propio teléfono.</p>
      </div>`;
  }

  private async screenPerson(id: string) {
    const i = await gallery.getIdentity(id);
    if (!i) return this.screenCircle();
    const enc = (await history.recent()).filter((e) => e.identityId === id);
    const errors = enc.filter((e) => e.reportedError).length;
    return `
      <div class="hero person">
        <button class="back" data-go="circulo">${icon('back', 18)} Círculo</button>
        <div class="who"><span class="avatar xl">${initials(i.name)}</span><div><h1>${esc(i.name)}</h1><p>${esc(i.relation)}</p></div></div>
      </div>
      <div class="pad">
        <div class="panel form">
          <label>Lo que escucha al verla
            <div class="with-btn"><input id="phrase" value="${esc(i.phrase)}" maxlength="80" /><button class="icon-btn" data-act="preview" title="Escuchar">${icon('speaker', 18)}</button></div>
            <small>Corta: primero el nombre y después el vínculo.</small></label>
          <label>Vínculo<input id="relation" value="${esc(i.relation)}" maxlength="40" /></label>
          ${i.consent.notes
            ? `<label><span>Dato para la tarjeta <small class="inline">(opcional)</small></span><input id="context" placeholder="vive en Rosario" value="${esc(i.context)}" /></label>
               <label>Notas para conversar<textarea id="notes" rows="3" placeholder="Viene los martes · nietos Lucía y Tomás">${esc(i.notes.join('\n'))}</textarea></label>`
            : '<p class="muted small">No autorizó notas de conversación.</p>'}
          <button class="btn block" data-act="save-person" data-id="${i.id}">Guardar</button>
        </div>
        <div class="panel">
          <h3>Esta semana</h3>
          <div class="stats flat"><div><b>${i.consent.encounterLog ? enc.length : '—'}</b><span>veces reconocida</span></div><div><b>${errors}</b><span>errores marcados</span></div></div>
          ${i.consent.encounterLog ? '' : '<p class="muted small">No autorizó registrar los encuentros.</p>'}
          <ul class="facts">
            <li>${icon('check', 16)} Fotos: ninguna guardada · ${i.validShots} tomas${gallery.isWeak(i) ? ' (conviene rehacerlas)' : ''}</li>
            <li>${icon('check', 16)} Permiso vigente hasta el ${ddmmyyyy(i.expiresAt)}</li>
          </ul>
        </div>
        <button class="btn block ghost" data-act="regen" data-id="${i.id}">${icon('camera', 18)} Rehacer las fotos</button>
        <button class="btn block danger" data-act="revoke" data-id="${i.id}">${icon('trash', 18)} Quitar del círculo</button>
      </div>`;
  }

  private async screenHistory() {
    const [enc, ids] = await Promise.all([history.recent(), gallery.list()]);
    const days = new Map<string, history.Encounter[]>();
    for (const e of enc) {
      const d = new Date(e.ts);
      const today = new Date();
      const yest = new Date(Date.now() - 864e5);
      const key = d.toDateString() === today.toDateString() ? 'Hoy' : d.toDateString() === yest.toDateString() ? 'Ayer'
        : d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
      days.set(key, [...(days.get(key) ?? []), e]);
    }
    return `
      <div class="hero"><h1>Historial</h1><p>Últimos 7 días · se borra solo</p></div>
      <div class="pad">
        ${enc.length ? [...days].map(([day, list]) => `<div class="panel"><h3 class="day">${esc(day)}</h3>${this.timeline(list, ids, true)}</div>`).join('')
          : `<div class="empty-block">${icon('clock', 32)}<p>Todavía no hay encuentros.</p></div>`}
        <p class="footnote center">Si un aviso estuvo mal, marcalo con «¿Se equivocó?»: sirve para ajustar la seguridad.<br/>Se guarda la hora y a quién reconoció. <b>Nunca imágenes, audio ni ubicación.</b></p>
      </div>`;
  }

  private async screenSettings() {
    const s = this.settings;
    const n = (await gallery.active()).length;
    const preset = SAFETY.find((p) => Math.abs(p.tau - s.tauHigh) < 0.005);
    const est = s.calibration ? estimate(s.calibration, s.tauHigh) : null;
    const per = (v: number, base: number) => (v * base < 1 ? `menos de 1 de cada ${base}` : `~${Math.round(v * base)} de cada ${base}`);
    return `
      <div class="hero"><h1>Ajustes</h1><p>Elegí cómo y cuándo avisa</p></div>
      <div class="pad">
        <div class="panel">
          <h3>¿Cuándo habla?</h3>
          <div class="seg" data-seg="mode">
            <button data-v="auto" class="${s.onDemand ? '' : 'on'}">Solo, al ver a alguien</button>
            <button data-v="demand" class="${s.onDemand ? 'on' : ''}">Sólo si pregunto</button>
          </div>
          <div class="${s.onDemand ? 'dim' : ''}">
            ${this.toggle('announceOnChange', 'Avisar cuando cambia la persona', 'Si llega otra persona, dice quién es.')}
            ${this.toggle('announceUnknown', 'Avisar si no es nadie conocido', '«No es nadie conocido. Podés invitarlo a sumarse al círculo.»')}
          </div>
        </div>

        <div class="panel">
          <h3>Voz</h3>
          ${this.toggle('voice', 'Hablar en voz alta', 'Con la voz del dispositivo, sin internet.')}
          ${this.toggle('listen', 'Escuchar «¿Quién es?»', 'El micrófono queda abierto; lo que decís se entiende en el dispositivo y no se guarda.')}
        </div>

        <div class="panel">
          <h3>¿Qué tan seguro antes de decir un nombre?</h3>
          <div class="seg" data-seg="safety">
            ${SAFETY.map((p) => `<button data-v="${p.tau}" class="${preset?.key === p.key ? 'on' : ''}">${p.label}</button>`).join('')}
          </div>
          <p class="explain">${preset ? preset.text : `Ajuste personalizado (τ = ${num(s.tauHigh)}).`} Si duda, dice «no estoy seguro» en lugar de arriesgar un nombre.</p>
          ${est ? `<p class="estimate">Con ${n} ${n === 1 ? 'persona' : 'personas'} en el círculo: nombra mal ${per(est.fpir, 1000)} veces · se queda callado ante un conocido ${per(est.fnir, 100)}.</p>` : ''}
        </div>

        <div class="panel">
          <h3>Cámara</h3>
          <div class="seg" data-seg="facing">
            <button data-v="user" class="${s.facing === 'user' ? 'on' : ''}">Frontal</button>
            <button data-v="environment" class="${s.facing === 'environment' ? 'on' : ''}">Trasera</button>
          </div>
          <p class="explain">En el teléfono, la trasera a la altura de los ojos simula las gafas.</p>
        </div>

        <div class="panel">
          <h3>Privacidad</h3>
          <ul class="facts">
            <li>${icon('check', 16)} Fotos y audio: <b>nunca se guardan</b></li>
            <li>${icon('check', 16)} Caras que no conoce: no se guarda nada</li>
            <li>${icon('check', 16)} Historial: se borra a los 7 días</li>
            <li>${icon('check', 16)} Cada persona puede retirar su permiso cuando quiera</li>
            <li>${icon('check', 16)} Conexiones a internet en esta sesión: <b data-egress>${this.egress}</b></li>
          </ul>
        </div>

        <details class="panel advanced">
          <summary>Avanzado</summary><div class="adv-body">
          ${this.toggle('details', 'Detalles técnicos', 'Muestra similitud, umbral y rendimiento. Útil para presentaciones.')}
          <div class="between"><span>Umbral para confirmar identidad</span><b id="tau-v">τ = ${num(s.tauHigh)}</b></div>
          <input type="range" id="tau" min="0.2" max="0.6" step="0.01" value="${s.tauHigh}" aria-label="Umbral" />
          <p class="explain">Entre ${num(Math.max(0, s.tauHigh - ABSTAIN_BAND))} y ${num(s.tauHigh)} se abstiene («no estoy seguro»).</p>
          <div class="between"><span>Tiempo frente a la persona antes de avisar</span><b id="dwell-v">${num(s.dwellMs / 1000, 1)} s</b></div>
          <input type="range" id="dwell" min="0" max="3000" step="100" value="${s.dwellMs}" aria-label="Permanencia" />
          <label class="file">${icon('download', 16)} ${s.calibration ? `Calibración cargada (N = ${s.calibration.galleryN}) · cambiar` : 'Cargar calibración (eval_report.json)'}<input type="file" id="calib" accept="application/json" /></label>
          <div class="two">
            <button class="btn ghost small" data-act="export">${icon('download', 16)} Auditoría</button>
            <button class="btn ghost small danger" data-act="wipe">${icon('trash', 16)} Borrar a todos</button>
          </div>
        </div></details>
      </div>`;
  }

  private toggle(key: ToggleKey, title: string, sub: string) {
    return `<label class="setting"><div><b>${title}</b><small>${sub}</small></div><input type="checkbox" class="switch-input" data-setting="${key}" ${this.settings[key] ? 'checked' : ''}/></label>`;
  }

  private bindScreen(screen: HTMLElement) {
    screen.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
      b.addEventListener('click', () => { this.tab = b.dataset.go as Tab; this.renderPhone(); }));
    screen.querySelectorAll<HTMLElement>('[data-person]').forEach((b) =>
      b.addEventListener('click', async () => { screen.innerHTML = await this.screenPerson(b.dataset.person!); screen.scrollTop = 0; this.bindScreen(screen); }));
    screen.querySelectorAll<HTMLElement>('[data-report]').forEach((b) =>
      b.addEventListener('click', async () => {
        await history.reportError(Number(b.dataset.report));
        toast('Marcado. Si pasa seguido, probá la seguridad «Prudente».', 'info');
        this.renderPhone();
      }));
    screen.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act!, b.dataset.id)));

    screen.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((inp) =>
      inp.addEventListener('change', async () => {
        await this.setToggle(inp.dataset.setting as ToggleKey, inp.checked);
        if (inp.dataset.setting === 'details') this.renderPhone();
      }));

    screen.querySelectorAll<HTMLElement>('.seg').forEach((seg) =>
      seg.addEventListener('click', async (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
        if (!b) return;
        const v = b.dataset.v!;
        if (seg.dataset.seg === 'mode') await this.setToggle('onDemand', v === 'demand');
        if (seg.dataset.seg === 'safety') {
          this.settings.tauHigh = Number(v);
          await saveSettings(this.settings);
          this.applyDecisionSettings();
        }
        if (seg.dataset.seg === 'facing') {
          this.settings.facing = v as Settings['facing'];
          await saveSettings(this.settings);
          if (!this.settings.privacyMode) await this.startCamera();
        }
        this.renderPhone();
      }));

    const tau = screen.querySelector<HTMLInputElement>('#tau');
    tau?.addEventListener('input', () => { $('#tau-v').textContent = `τ = ${num(Number(tau.value))}`; });
    tau?.addEventListener('change', async () => {
      this.settings.tauHigh = Number(tau.value);
      await saveSettings(this.settings);
      this.applyDecisionSettings();
      this.renderPhone().then(() => screen.querySelector<HTMLDetailsElement>('details.advanced')?.setAttribute('open', ''));
    });
    const dwell = screen.querySelector<HTMLInputElement>('#dwell');
    dwell?.addEventListener('input', () => { $('#dwell-v').textContent = `${num(Number(dwell.value) / 1000, 1)} s`; });
    dwell?.addEventListener('change', async () => {
      this.settings.dwellMs = Number(dwell.value);
      await saveSettings(this.settings);
      this.applyDecisionSettings();
    });
    const calib = screen.querySelector<HTMLInputElement>('#calib');
    calib?.addEventListener('change', async () => {
      const file = calib.files?.[0];
      if (!file) return;
      try {
        this.settings.calibration = await parseCalibration(await file.text(), (await gallery.active()).length);
        await saveSettings(this.settings);
        toast('Calibración cargada', 'ok');
      } catch (e) {
        toast(`Archivo inválido: ${(e as Error).message}`, 'warn');
      }
      this.renderPhone();
    });
  }

  private async act(action: string, id?: string) {
    if (action === 'invite') return this.enroll();
    if (action === 'regen' && id) return this.enroll(id);
    if (action === 'preview') return speak($<HTMLInputElement>('#phrase').value || '', true);
    if (action === 'save-person' && id) {
      const notes = document.querySelector<HTMLTextAreaElement>('#notes');
      const context = document.querySelector<HTMLInputElement>('#context');
      await gallery.update(id, {
        phrase: $<HTMLInputElement>('#phrase').value.trim(),
        relation: $<HTMLInputElement>('#relation').value.trim(),
        ...(notes ? { notes: notes.value.split('\n').map((l) => l.trim()).filter(Boolean) } : {}),
        ...(context ? { context: context.value.trim() } : {}),
      });
      toast('Guardado', 'ok');
      this.tab = 'circulo';
      return this.renderPhone();
    }
    if (action === 'revoke' && id) {
      const i = await gallery.getIdentity(id);
      const ok = await confirmDialog(`¿Quitar a ${i?.name} del círculo?`,
        'Se borran su código facial, sus notas y su historial. No se puede deshacer.', 'Quitar');
      if (!ok) return;
      await gallery.revoke(id);
      await history.forgetIdentity(id);
      this.pipe.engine.reset();
      toast(`${i?.name} ya no está en el círculo`, 'ok');
      this.tab = 'circulo';
      return this.renderPhone();
    }
    if (action === 'wipe') {
      const ok = await confirmDialog('¿Borrar a todas las personas?', 'Se eliminan todos los códigos faciales y su historial. No se puede deshacer.', 'Borrar todo');
      if (!ok) return;
      for (const i of await gallery.list()) await history.forgetIdentity(i.id);
      await gallery.wipeAll();
      this.pipe.engine.reset();
      toast('Círculo vacío', 'ok');
      return this.renderPhone();
    }
    if (action === 'export') {
      const blob = new Blob([JSON.stringify(await gallery.auditLog(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mnemo-auditoria-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  // ================================================================ enrollment with consent
  private wizard(step: number, title: string, body: string, opts: { dark?: boolean } = {}) {
    const names = ['Invitación', 'Permiso', 'Fotos', 'Datos'];
    return `
      <div class="wizard ${opts.dark ? 'dark' : ''}">
        <div class="wiz-top">
          <button class="icon-btn" id="wiz-close" aria-label="Cancelar">${icon('x', 20)}</button>
          <ol class="wiz-steps">${names.map((n, i) => `<li class="${i < step ? 'done' : i === step ? 'on' : ''}"><i></i><span>${n}</span></li>`).join('')}</ol>
        </div>
        <h1 class="wiz-title">${title}</h1>
        ${body}
      </div>`;
  }

  private async enroll(replaceId?: string): Promise<void> {
    if (!this.source || this.settings.privacyMode || this.cameraError) {
      toast(this.settings.privacyMode ? 'Reanudá la cámara para agregar a alguien.' : 'Se necesita la cámara para las fotos.', 'warn');
      return;
    }
    this.enrolling = true;
    this.renderOverlay();
    this.setStatus('Agregando a alguien al círculo…', 'idle');
    $('#card').innerHTML = '';
    this.setView('phone');
    const screen = $('#screen');
    screen.scrollTop = 0;
    const replacing = replaceId ? await gallery.getIdentity(replaceId) : undefined;
    let cancelled = false;
    const finish = async () => {
      this.enrolling = false;
      this.pipe.engine.reset();
      await this.renderPhone();
    };
    const bindClose = (onClose: () => void) => { $('#wiz-close', screen).onclick = onClose; };

    // Step 1 · Invitation
    const code = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    screen.innerHTML = this.wizard(0, replacing ? `Rehacer las fotos de ${esc(replacing.name)}` : 'Invitá a alguien de confianza', `
      <div class="panel center"><div class="qr">${fakeQr(code)}</div><b>MN-${code}</b><small class="muted">Sirve una sola vez y vence en ${ENROLLMENT.inviteTtlHours} h</small></div>
      <ol class="steps-big">
        <li><b>La persona escanea el código con su teléfono.</b></li>
        <li><b>Lee y acepta el permiso.</b><span>Decide qué comparte.</span></li>
        <li><b>Se saca 5 fotos guiadas.</b><span>Las fotos se borran al instante; queda sólo un código cifrado.</span></li>
      </ol>
      <p class="note">En esta demo, el alta se hace en este mismo navegador.</p>
      <button class="btn block big" id="go">Continuar</button>`);
    const step1 = await new Promise<boolean>((r) => { $('#go', screen).onclick = () => r(true); bindClose(() => r(false)); });
    if (!step1) return finish();

    // Step 2 · Consent (comes before the capture)
    screen.innerHTML = this.wizard(1, 'Tu cara, tus reglas', `
      <ul class="consent">
        <li>${icon('glasses', 20)}<div><b>Para qué</b><span>Para que quien usa las gafas escuche tu nombre cuando te encuentre.</span></div></li>
        <li>${icon('shield', 20)}<div><b>Qué se guarda</b><span>Un código numérico cifrado a partir de tu cara. <b>Ninguna foto ni video.</b></span></div></li>
        <li>${icon('sparkle', 20)}<div><b>Dónde</b><span>Sólo en el dispositivo de quien usa las gafas. Nada va a internet.</span></div></li>
        <li>${icon('clock', 20)}<div><b>Por cuánto tiempo</b><span>12 meses. Podés retirarlo cuando quieras y se borra todo.</span></div></li>
      </ul>
      <div class="panel">
        <label class="setting"><div><b>Que me nombre al verme</b><small>Necesario para sumarte</small></div><input type="checkbox" class="switch-input" id="c-id" checked /></label>
        <label class="setting"><div><b>Notas para conversar</b><small>Ej.: «vive en Rosario»</small></div><input type="checkbox" class="switch-input" id="c-notes" checked /></label>
        <label class="setting"><div><b>Registrar cuándo nos vemos</b><small>7 días, sin imágenes</small></div><input type="checkbox" class="switch-input" id="c-log" /></label>
      </div>
      <button class="btn block big" id="accept">Acepto</button>
      <button class="btn block ghost" id="decline">No, gracias</button>
      <p class="footnote center">Ley 25.326 · consentimiento libre, expreso e informado</p>`);
    const idBox = $<HTMLInputElement>('#c-id', screen);
    idBox.onchange = () => { $<HTMLButtonElement>('#accept', screen).disabled = !idBox.checked; };
    const consent = await new Promise<gallery.Consent | null>((r) => {
      $('#accept', screen).onclick = () => r({
        identification: idBox.checked,
        notes: $<HTMLInputElement>('#c-notes', screen).checked,
        encounterLog: $<HTMLInputElement>('#c-log', screen).checked,
      });
      $('#decline', screen).onclick = () => r(null);
      bindClose(() => { cancelled = true; r(null); });
    });
    if (!consent) {
      if (!cancelled) toast('No se tomó ninguna foto y la invitación quedó anulada.', 'info', 4500);
      return finish();
    }

    // Step 3 · Guided capture
    const vecs = await this.guidedCapture(screen);
    if (!vecs) return finish();
    if (!vecs.length) {
      toast('No se logró ninguna foto válida. Probá con más luz.', 'warn', 4500);
      return finish();
    }
    const template = centroid(vecs);
    vecs.length = 0; // the per-shot vectors are discarded too: only the centroid remains

    if (replacing) {
      await gallery.revoke(replacing.id, 'regeneracion');
      await gallery.enroll({
        name: replacing.name, relation: replacing.relation, phrase: replacing.phrase, context: replacing.context,
        template, consent, validShots: this.lastValidShots,
      });
      toast(`Fotos de ${replacing.name} actualizadas`, 'ok');
      return finish();
    }

    // Step 4 · Details (filled in by the caregiver)
    screen.innerHTML = this.wizard(3, '¿Quién es?', `
      <div class="panel form">
        <label>Nombre<input id="f-name" placeholder="Marta" autocomplete="off" /></label>
        <label>Vínculo con quien usa las gafas<input id="f-rel" placeholder="tu hija" autocomplete="off" /></label>
        <label>Lo que va a escuchar
          <div class="with-btn"><input id="f-phrase" placeholder="Es Marta, tu hija." /><button class="icon-btn" id="f-play" title="Escuchar">${icon('speaker', 18)}</button></div>
          <small>Se completa sola; podés cambiarla.</small></label>
        ${consent.notes ? '<label><span>Dato para la tarjeta <small class="inline">(opcional)</small></span><input id="f-ctx" placeholder="vive en Rosario" /></label>' : ''}
      </div>
      <button class="btn block big" id="save" disabled>Guardar</button>`);
    const name = $<HTMLInputElement>('#f-name', screen);
    const rel = $<HTMLInputElement>('#f-rel', screen);
    const phrase = $<HTMLInputElement>('#f-phrase', screen);
    const save = $<HTMLButtonElement>('#save', screen);
    const sync = () => {
      phrase.placeholder = `Es ${name.value.trim() || 'Marta'}, ${rel.value.trim() || 'tu hija'}.`;
      save.disabled = !name.value.trim() || !rel.value.trim();
    };
    name.oninput = rel.oninput = sync;
    $('#f-play', screen).onclick = () => speak(phrase.value.trim() || phrase.placeholder, true);
    name.focus();
    const saved = await new Promise<boolean>((r) => { save.onclick = () => r(true); bindClose(() => r(false)); });
    if (!saved) return finish();
    const ident = await gallery.enroll({
      name: name.value.trim(), relation: rel.value.trim(), phrase: phrase.value.trim() || undefined,
      context: document.querySelector<HTMLInputElement>('#f-ctx')?.value.trim(), template, consent,
      validShots: this.lastValidShots,
    });

    // Done
    screen.innerHTML = `
      <div class="wizard done">
        <div class="done-mark">${icon('check', 40)}</div>
        <h1 class="wiz-title">${esc(ident.name)} ya está en el círculo</h1>
        <p class="explain center">La próxima vez que aparezca frente a la cámara vas a escuchar:</p>
        <p class="quote">«${esc(ident.phrase)}»</p>
        <button class="btn block big" id="try">${icon('glasses', 20)} Probarlo ahora</button>
        <button class="btn block ghost" id="another">${icon('userPlus', 20)} Agregar otra persona</button>
      </div>`;
    const next = await new Promise<'try' | 'another'>((r) => {
      $('#try', screen).onclick = () => r('try');
      $('#another', screen).onclick = () => r('another');
    });
    this.tab = 'inicio';
    await finish();
    if (next === 'another') return this.enroll();
    this.setView('wearer');
  }

  private lastValidShots = 0;

  /** Five guided shots, checking detection, size, sharpness and pose. Returns the vectors, or null if cancelled. */
  private async guidedCapture(screen: HTMLElement): Promise<Float32Array[] | null> {
    const shots = ENROLLMENT.shots;
    screen.innerHTML = this.wizard(2, 'Fotos guiadas', `
      <div class="cap-view"><canvas id="cap-canvas"></canvas><svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/><circle id="ring" cx="50" cy="50" r="46"/></svg></div>
      <h2 id="cap-hint" class="cap-hint">${shots[0].hint}</h2>
      <p id="cap-sub" class="cap-sub">Buscando tu cara…</p>
      <ol class="shots">${shots.map((s, k) => `<li class="shot" data-k="${k}"><i></i><span>${s.label}</span></li>`).join('')}</ol>
      <button class="btn block ghost" id="skip">Saltear esta foto</button>
      <p class="footnote center">Las fotos <b>no se guardan</b>: cada una se convierte en un código y se borra al instante.</p>`, { dark: true });
    const canvas = $<HTMLCanvasElement>('#cap-canvas', screen);
    const ring = screen.querySelector<SVGCircleElement>('#ring')!;
    const C = 2 * Math.PI * 46;
    ring.style.strokeDasharray = `${C}`;
    const setRing = (f: number) => { ring.style.strokeDashoffset = `${C * (1 - f)}`; };
    setRing(0);
    const vecs: Float32Array[] = [];
    let k = 0, stable = 0, skip = false, abort = false, firstProfileSign = 0, shotStart = performance.now();
    const NEED = 4;
    $('#skip', screen).onclick = () => { skip = true; };
    $('#wiz-close', screen).onclick = () => { abort = true; };
    const mark = (i: number, ok: boolean) => screen.querySelector(`.shot[data-k="${i}"]`)!.classList.add(ok ? 'ok' : 'skipped');
    const frame = document.createElement('canvas');

    while (k < shots.length) {
      if (abort) return null;
      screen.querySelectorAll('.shot').forEach((el, i) => el.classList.toggle('on', i === k));
      $('#cap-hint', screen).textContent = shots[k].hint;
      $('#skip', screen).classList.toggle('emph', performance.now() - shotStart > 7000);
      if (skip) { mark(k, false); k++; skip = false; stable = 0; setRing(0); shotStart = performance.now(); continue; }
      if (!this.source!.grab(frame)) { await new Promise((r) => requestAnimationFrame(r)); continue; }
      const isProfile = shots[k].key.startsWith('perfil');
      const a = await this.pipe.analyze(frame, { allowProfile: isProfile });
      drawFrame(canvas, frame, a.face ? { face: a.face, quality: a.quality, zone: a.quality?.ok ? 'match' : 'reject', sMax: -1 } as FrameResult : null,
        this.settings.facing === 'user', this.settings.details);

      let why = a.face ? (a.quality!.reason ? FRIENDLY[a.quality!.reason] ?? a.quality!.reason : null) : 'No veo tu cara';
      if (!why && a.face) {
        const yaw = a.quality!.yaw;
        if (!isProfile && Math.abs(yaw) > 0.2) why = 'Mirá de frente a la cámara';
        if (isProfile) {
          if (Math.abs(yaw) < 0.15) why = 'Girá un poco más';
          else if (firstProfileSign && Math.sign(yaw) === firstProfileSign) why = 'Ahora hacia el otro lado';
        }
      }
      if (a.faces > 1) why = 'Que haya una sola persona frente a la cámara';
      stable = why || !a.embedding ? 0 : stable + 1;
      setRing(stable / NEED);
      $('#cap-sub', screen).textContent = why ?? '¡Así! Quedate quieto…';
      $('#cap-sub', screen).classList.toggle('good', !why);
      if (stable >= NEED && a.embedding) {
        vecs.push(a.embedding);
        if (isProfile && !firstProfileSign) firstProfileSign = Math.sign(a.quality!.yaw);
        mark(k, true);
        k++;
        stable = 0;
        shotStart = performance.now();
        $('#cap-sub', screen).textContent = k < shots.length ? '¡Lista!' : '¡Terminamos!';
        await new Promise((r) => setTimeout(r, 600));
        setRing(0);
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    frame.width = frame.height = 0;
    this.lastValidShots = vecs.length;
    if (vecs.length && vecs.length < ENROLLMENT.minValidShots) {
      toast(`Sólo ${vecs.length} fotos válidas: va a reconocer con más cautela. Podés rehacerlas después.`, 'warn', 5000);
    }
    return vecs;
  }
}

/** Reads the `mnemo-eval` report and picks the DET curve whose gallery size is closest to the current one. */
async function parseCalibration(text: string, n: number): Promise<Calibration> {
  const rep = JSON.parse(text) as Record<string, { det: { tau: number[]; fpir: number[]; fnir: number[] }; N_test: number }>;
  const entries = Object.values(rep).filter((r) => r?.det?.tau?.length);
  if (!entries.length) throw new Error('no contiene curvas DET');
  const best = entries.reduce((a, b) => (Math.abs(b.N_test - n) < Math.abs(a.N_test - n) ? b : a));
  return { ...best.det, galleryN: best.N_test };
}

/** Decorative QR (deterministic from the code). The real app generates an actual QR with the signed token. */
function fakeQr(code: string) {
  let seed = [...code].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const n = 21, cells: string[] = [];
  const finder = (x: number, y: number) =>
    [[0, 0], [n - 7, 0], [0, n - 7]].some(([fx, fy]) => {
      const dx = x - fx, dy = y - fy;
      if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
      return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
    });
  const inFinderZone = (x: number, y: number) => [[0, 0], [n - 8, 0], [0, n - 8]].some(([fx, fy]) => x >= fx && x <= fx + 7 && y >= fy && y <= fy + 7);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const on = inFinderZone(x, y) ? finder(x, y) : rnd() > 0.5;
    if (on) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
  }
  return `<svg viewBox="-1 -1 ${n + 2} ${n + 2}" aria-label="Código de invitación">${cells.join('')}</svg>`;
}
