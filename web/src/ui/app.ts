import { ABSTAIN_BAND, ENROLLMENT, MAX_GALLERY, NOBODY_PHRASE, UNCLEAR_PHRASE } from '../pipeline/config';
import { WebcamSource } from '../pipeline/capture';
import { centroid } from '../pipeline/models';
import type { FrameResult, Pipeline } from '../pipeline/pipeline';
import * as gallery from '../store/gallery';
import * as history from '../store/history';
import { type Calibration, estimate, loadSettings, saveSettings, type Settings } from '../store/settings';
import { type ListenerStatus, VoiceListener } from '../voice/listener';
import { drawFrame } from './live';
import { $, ddmmyyyy, esc, hhmm, initials, isToday, num, speak, watchEgress } from './util';

type Tab = 'inicio' | 'circulo' | 'historial' | 'privacidad';
type ToggleKey = 'privacyMode' | 'onDemand' | 'voice' | 'announceOnChange' | 'announceUnknown' | 'listen';

const STATE_LABEL: Record<string, string> = {
  en_reposo: 'En reposo',
  observando: 'Observando',
  afirmando: 'Afirmando',
  absteniendose: 'Absteniéndose',
  descartando: 'Descartando',
};

export class App {
  private settings!: Settings;
  private source!: WebcamSource;
  private frame = document.createElement('canvas');
  private tab: Tab = 'inicio';
  private running = false;
  private enrolling = false;
  private demand = { until: 0 };
  private egress = 0;
  private lastAnnouncement: { res: FrameResult; at: number } | null = null;
  private fps = 0;
  private discardCounted = false;
  /** «¿Quién es?» pendiente de respuesta: si vence sin aviso, se explica por qué (nadie / cara poco visible). */
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
      const el = document.getElementById('egress');
      if (el) el.textContent = `${n} conexiones salientes en esta sesión`;
    });
    await this.renderPhone();
    this.listener.muted = () => 'speechSynthesis' in window && speechSynthesis.speaking;
    if (!this.settings.privacyMode) {
      await this.startCamera();
      // El micrófono necesita un gesto del usuario en algunos navegadores; si falla, queda el botón.
      if (this.settings.listen) this.listener.start().catch(() => this.onListenerStatus('error', 'tocá el interruptor para reactivar'));
    } else this.renderPrivacyOverlay();
  }

  /** «¿Quién es?» por botón, barra espaciadora o voz: encuentro nuevo que siempre responde. */
  private ask() {
    if (this.settings.privacyMode) return;
    this.pipe.engine.request();
    this.lastAnnouncement = null;
    this.pendingAsk = { at: performance.now(), sawFace: false };
    this.demand.until = performance.now() + 5000;
  }

  private onListenerStatus(s: ListenerStatus, detail?: string) {
    const el = document.getElementById('mic');
    if (el) {
      el.className = `mic ${s}`;
      el.textContent = { apagado: 'Micrófono apagado', cargando: 'Cargando voz…', escuchando: 'Escuchando «¿quién es?»', transcribiendo: 'Transcribiendo…', error: 'Voz no disponible' }[s];
      el.title = detail ?? '';
    }
    const err = document.getElementById('mic-error');
    if (err) err.textContent = s === 'error' ? (detail ?? '') : '';
    const d = document.getElementById('mic-detail');
    if (d) d.textContent = detail ?? '';
  }

  // ---------------------------------------------------------------- cámara y ciclo
  private async startCamera() {
    this.source?.stop();
    this.source = new WebcamSource(this.settings.facing);
    try {
      await this.source.start();
    } catch (e) {
      $('#wearer-status').textContent = `No se pudo abrir la cámara: ${(e as Error).message}`;
      return;
    }
    $('#source-name').textContent = this.source.name;
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
    while (this.running) {
      if (this.enrolling) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const dims = this.source.grab(this.frame);
      if (!dims) {
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
      drawFrame(canvas, this.frame, res, this.settings.facing === 'user');
      this.renderWearerHud(res, active);
      this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, performance.now() - last));
      last = performance.now();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  private async onResult(res: FrameResult) {
    if (res.state === 'en_reposo') this.discardCounted = false;
    if (res.state === 'descartando' && !this.discardCounted) {
      await history.countDiscard(); // RN-04: sólo un evento anónimo en el contador del día
      this.discardCounted = true;
    }
    const ann = res.announcement;
    if (!ann || !res.phrase) return;
    this.pendingAsk = null;
    this.lastAnnouncement = { res, at: performance.now() };
    speak(res.phrase, this.settings.voice);
    if (this.settings.onDemand) this.demand.until = 0;
    // Sin autorización de registro, el aviso se anota sin identidad: el cuidador ve que el sistema habló,
    // pero no a quién (P-04, tercer permiso).
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
    speak(p.sawFace ? UNCLEAR_PHRASE : NOBODY_PHRASE, this.settings.voice);
  }

  // ---------------------------------------------------------------- vista del portador
  private renderWearerHud(res: FrameResult | null, active: boolean) {
    const status = $('#wearer-status');
    const dot = $('#wearer-dot');
    if (this.settings.onDemand && !active) {
      status.textContent = 'Sólo a pedido · presioná «¿Quién es?» o la barra espaciadora';
      dot.className = 'dot idle';
    } else if (res?.state === 'absteniendose' || res?.zone === 'abstain') {
      status.textContent = 'Coincidencia por debajo del umbral';
      dot.className = 'dot warn';
    } else {
      status.textContent = 'Procesando en el dispositivo · sin conexión';
      dot.className = 'dot ok';
    }
    $('#wearer-state').textContent = `${STATE_LABEL[this.pipe.engine.state]} · ${num(this.fps, 1)} fps`;

    const card = $('#wearer-card');
    const ear = $('#wearer-ear');
    const a = this.lastAnnouncement;
    const fresh = a && performance.now() - a.at < 6000;
    if (!fresh) {
      card.innerHTML = '';
      ear.classList.remove('show', 'abstain');
      if (res?.face && res.quality) {
        const q = res.quality;
        card.innerHTML = `<div class="meta">${q.ok
          ? `${res.candidate ? `mejor candidata ${num(res.sMax)}` : 'galería vacía'} · τ = ${num(this.pipe.engine.cfg.tauHigh)} · ${this.timing(res)} ms`
          : `cuadro inutilizable: ${esc(q.reason)} · nitidez ${Math.round(q.sharpness)}`}</div>`;
      }
      return;
    }
    const r = a!.res;
    const ann = r.announcement!;
    const tau = this.pipe.engine.cfg;
    if (ann.kind === 'match' && r.identity) {
      card.innerHTML = `
        <h2>${esc(r.identity.name)}</h2>
        <p>${esc(r.identity.relation)}${r.identity.context ? ` · ${esc(r.identity.context)}` : ''}</p>
        <div class="meta">similitud ${num(ann.sMax)} · confirmado en ${ann.hits} de ${ann.window} cuadros · τ = ${num(tau.tauHigh)} · ${Math.round(ann.latencyMs)} ms</div>`;
      ear.classList.remove('abstain');
    } else if (ann.kind === 'unknown') {
      card.innerHTML = `
        <h2>No es nadie conocido</h2>
        <p>Podés invitarlo a sumarse al círculo.</p>
        <div class="meta">mejor candidata ${num(ann.sMax)} &lt; ${num(tau.tauLow)} · sin registro biométrico</div>`;
      ear.classList.add('abstain');
    } else {
      card.innerHTML = `
        <h2>No estoy seguro</h2>
        <p>No digo ningún nombre. Podés preguntarle cómo se llama.</p>
        <div class="meta">mejor candidata ${num(ann.sMax)} · banda de abstención ${num(tau.tauLow)}–${num(tau.tauHigh)} · cuadro descartado, nada almacenado</div>`;
      ear.classList.add('abstain');
    }
    ear.classList.add('show');
    $('#wearer-ear-text').textContent = `«${r.phrase}»`;
  }

  private startListening() {
    this.listener.start().catch((e) => this.onListenerStatus('error', (e as Error).message));
  }

  private timing(res: FrameResult) {
    return Math.round(Object.values(res.timings).reduce((a, b) => a + b, 0));
  }

  private renderPrivacyOverlay() {
    const c = $<HTMLCanvasElement>('#wearer-canvas');
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, c.width, c.height);
    $('#wearer-status').textContent = 'Modo privacidad · cámara y avisos suspendidos';
    $('#wearer-dot').className = 'dot idle';
    $('#wearer-card').innerHTML = '<h2>Pausado</h2><p>No hay captura ni inferencia.</p>';
    $('#wearer-state').textContent = 'En reposo';
  }

  // ---------------------------------------------------------------- estructura
  private shell() {
    return `
    <header class="topbar">
      <div class="brand"><span class="logo">M</span><div><strong>MNEMO</strong><small>demo web · reconocimiento facial consentido</small></div></div>
      <nav class="switch" role="tablist">
        <button data-view="wearer" class="on">Vista del portador</button>
        <button data-view="phone">App del cuidador</button>
      </nav>
    </header>
    <main class="stage" data-view="wearer">
      <section class="wearer">
        <div class="viewport">
          <canvas id="wearer-canvas"></canvas>
          <div class="hud-top"><span id="wearer-dot" class="dot ok"></span><span id="wearer-status">Iniciando cámara…</span><span class="spacer"></span><span id="wearer-state" class="state"></span></div>
          <div class="hud-bottom">
            <div id="wearer-card" class="card-id"></div>
            <div id="wearer-ear" class="ear"><small>AVISO AL OÍDO</small><div id="wearer-ear-text"></div><div class="bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
          </div>
        </div>
        <div class="wearer-actions">
          <button id="ask" class="btn">¿Quién es?</button>
          <span id="mic" class="mic apagado">Micrófono apagado</span><small id="mic-error" class="mic-error"></small>
          <span class="muted">Fuente: <b id="source-name">—</b> · En las gafas el portador no ve pantallas: sólo escucha la frase.</span>
        </div>
      </section>
      <section class="phone"><div class="device"><div class="statusbar"><span>${hhmm(Date.now())}</span><span>▮▮▮ ~ 82%</span></div><div id="screen" class="screen"></div>
        <nav class="tabs">${(['inicio', 'circulo', 'historial', 'privacidad'] as Tab[]).map((t) =>
          `<button data-tab="${t}"><span class="ico ico-${t}"></span>${{ inicio: 'Inicio', circulo: 'Círculo', historial: 'Historial', privacidad: 'Privacidad' }[t]}</button>`).join('')}</nav>
      </div></section>
    </main>`;
  }

  private bindShell() {
    this.root.querySelectorAll<HTMLButtonElement>('.switch button').forEach((b) =>
      b.addEventListener('click', () => {
        this.root.querySelectorAll('.switch button').forEach((x) => x.classList.toggle('on', x === b));
        $('.stage').dataset.view = b.dataset.view!;
      }));
    this.root.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
      b.addEventListener('click', () => { this.tab = b.dataset.tab as Tab; this.renderPhone(); }));
    const ask = () => this.ask();
    $('#ask').addEventListener('click', ask);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        ask();
      }
    });
  }

  // ---------------------------------------------------------------- app del cuidador
  private async renderPhone() {
    if (this.enrolling) return;
    this.root.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const screen = $('#screen');
    const html = await ({
      inicio: () => this.screenHome(),
      circulo: () => this.screenCircle(),
      historial: () => this.screenHistory(),
      privacidad: () => this.screenPrivacy(),
    })[this.tab]();
    screen.innerHTML = html;
    this.bindScreen(screen);
  }

  private async screenHome() {
    const [ids, enc, discards] = await Promise.all([gallery.list(), history.recent(), history.discardsToday()]);
    const today = enc.filter((e) => isToday(e.ts));
    const avisos = today.filter((e) => e.kind === 'aviso').length;
    const abst = today.filter((e) => e.kind === 'abstencion').length;
    return `
      <div class="hero"><small>MNEMO · CUIDADOR</small><h1>Hola</h1><p><span class="dot ok"></span> ${esc(this.source?.name ?? 'cámara')} · todo local</p></div>
      <div class="pad">
        <div class="stats"><div><b>${ids.length}</b><span>personas en el círculo</span></div><div><b>${avisos}</b><span>avisos hoy</span></div><div><b>${abst}</b><span>abstenciones</span></div></div>
        <div class="panel"><div class="panel-h"><b>Encuentros de hoy</b><button class="chip" data-go="historial">Ver todo</button></div>
          ${today.length ? today.slice(0, 5).map((e) => this.encounterRow(e, ids)).join('') : '<p class="muted small">Todavía no hubo encuentros hoy.</p>'}
          ${discards ? `<div class="row"><span class="avatar ghost">?</span><div class="grow"><b>Sin coincidencia</b><small>${discards} ${discards === 1 ? 'rostro descartado' : 'rostros descartados'} hoy · sin registro biométrico</small></div><span class="tag ghost">Descarte</span></div>` : ''}
        </div>
        <div class="note">Ninguna persona se enrola sin aceptar el consentimiento desde su propio teléfono. Las caras sin coincidencia no se guardan.</div>
        <button class="btn block" data-act="invite" ${ids.length >= MAX_GALLERY ? 'disabled' : ''}>+ Invitar a alguien al círculo</button>
      </div>`;
  }

  private encounterRow(e: history.Encounter, ids: gallery.Identity[]) {
    const ident = ids.find((i) => i.id === e.identityId);
    if (e.kind === 'desconocido') {
      return `<div class="row"><span class="avatar ghost">?</span><div class="grow"><b>No es nadie conocido</b><small>${hhmm(e.ts)} · ${num(e.similarity)} · sin registro biométrico</small></div><span class="tag ghost">Desconocido</span></div>`;
    }
    if (e.kind === 'abstencion') {
      return `<div class="row"><span class="avatar ghost">?</span><div class="grow"><b>Candidata bajo umbral</b><small>${hhmm(e.ts)} · ${num(e.similarity)} · banda de abstención</small></div><span class="tag ghost">Abstuvo</span></div>`;
    }
    if (!e.identityId) {
      return `<div class="row"><span class="avatar ghost">·</span><div class="grow"><b>Persona del círculo</b><small>${hhmm(e.ts)} · similitud ${num(e.similarity)} · sin registro de identidad autorizado</small></div><span class="tag">OK</span></div>`;
    }
    return `<div class="row"><span class="avatar">${initials(ident?.name ?? '?')}</span><div class="grow"><b>${esc(ident?.name ?? 'Revocada')} · ${esc(ident?.relation ?? '')}</b><small>${hhmm(e.ts)} · similitud ${num(e.similarity)} · ${Math.round(e.latencyMs)} ms${e.reportedError ? ' · <u>reportado</u>' : ''}</small></div><span class="tag">OK</span></div>`;
  }

  private async screenCircle() {
    const ids = await gallery.list();
    return `
      <div class="hero"><small>CÍRCULO DE CONFIANZA</small><h1>${ids.length} ${ids.length === 1 ? 'persona' : 'personas'}</h1><p>Hasta ${MAX_GALLERY} identidades · galería cerrada</p></div>
      <div class="pad">
        <div class="panel">${ids.length ? ids.map((i) => `
          <button class="row link" data-person="${i.id}"><span class="avatar">${initials(i.name)}</span><div class="grow"><b>${esc(i.name)} · ${esc(i.relation)}</b>
          <small>${gallery.isExpired(i) ? 'consentimiento vencido' : `vence ${ddmmyyyy(i.expiresAt)}`} · ${i.validShots} tomas${gallery.isWeak(i) ? ' · baja calidad' : ''}</small></div><span class="chev">›</span></button>`).join('')
          : '<p class="muted small">Nadie enrolado todavía.</p>'}</div>
        <button class="btn block" data-act="invite" ${ids.length >= MAX_GALLERY ? 'disabled' : ''}>+ Invitar a alguien al círculo</button>
      </div>`;
  }

  private async screenPerson(id: string) {
    const i = await gallery.getIdentity(id);
    if (!i) return this.screenCircle();
    const enc = (await history.recent()).filter((e) => e.identityId === id);
    const errors = enc.filter((e) => e.reportedError).length;
    const mean = enc.length ? enc.reduce((a, e) => a + e.similarity, 0) / enc.length : 0;
    return `
      <div class="hero person"><button class="back" data-go="circulo">‹ Círculo</button><small>CÍRCULO DE CONFIANZA</small>
        <div class="who"><span class="avatar xl">${initials(i.name)}</span><div><h1>${esc(i.name)}</h1><p>${esc(i.relation)} · enrolada el ${ddmmyyyy(i.enrolledAt)}</p></div></div></div>
      <div class="pad">
        <div class="chips"><span class="chip dark">Plantilla ${gallery.isWeak(i) ? 'baja' : 'alta'} · ${i.validShots} tomas</span><span class="chip">Vence ${ddmmyyyy(i.expiresAt)}</span><span class="chip">512-d · cifrado</span></div>
        <div class="panel"><small class="label">AVISO AL OÍDO</small>
          <input class="phrase" id="phrase" value="${esc(i.phrase)}" maxlength="80" />
          <small class="muted">Frase corta, primero el nombre y después el vínculo. Editable.</small></div>
        <div class="panel"><small class="label">NOTAS PARA CONVERSACIÓN</small>
          ${i.consent.notes
            ? `<textarea id="notes" rows="4" placeholder="· Vive en Rosario, viene los martes">${esc(i.notes.join('\n'))}</textarea><input id="context" placeholder="Dato de contexto para la tarjeta (opcional)" value="${esc(i.context)}" />`
            : '<p class="muted small">La persona no autorizó notas de conversación (consentimiento parcial).</p>'}</div>
        <div class="panel"><small class="label">DESEMPEÑO · 7 DÍAS</small>
          <div class="stats flat"><div><b>${enc.length}</b><span>avisos</span></div><div><b>${errors}</b><span>errores reportados</span></div><div><b>${enc.length ? num(mean) : '—'}</b><span>similitud media</span></div></div>
          ${i.consent.encounterLog ? '' : '<small class="muted">Sin registro de encuentros: la persona no lo autorizó.</small>'}</div>
        <button class="btn block ghost" data-act="save-person" data-id="${i.id}">Guardar cambios</button>
        <button class="btn block ghost" data-act="regen" data-id="${i.id}">Regenerar plantilla (5 tomas nuevas)</button>
        <button class="btn block danger" data-act="revoke" data-id="${i.id}">Revocar consentimiento y borrar</button>
      </div>`;
  }

  private async screenHistory() {
    const [enc, ids] = await Promise.all([history.recent(), gallery.list()]);
    const av = enc.filter((e) => e.kind === 'aviso').length;
    return `
      <div class="hero"><small>HISTORIAL · ÚLTIMOS 7 DÍAS</small><h1>${av} avisos · ${enc.filter((e) => e.kind === 'abstencion').length} abstenciones</h1><p>Se borra automáticamente a los 7 días</p></div>
      <div class="pad">
        <div class="panel">${enc.length ? enc.map((e) => `
          <div class="row"><div class="grow">${this.encounterRow(e, ids)}</div>
          ${e.kind === 'aviso' && !e.reportedError ? `<button class="chip" data-report="${e.ts}">¿Error?</button>` : ''}</div>`).join('')
          : '<p class="muted small">Sin encuentros registrados.</p>'}</div>
        <div class="panel"><small class="label">¿UN AVISO ESTUVO MAL?</small><p class="small">Reportalo para recalibrar el umbral y auditar falsos positivos. Usá «¿Error?» en la fila correspondiente.</p></div>
        <div class="note">El registro guarda hora, identidad y similitud. <b>No guarda imágenes, audio ni ubicación.</b></div>
      </div>`;
  }

  private async screenPrivacy() {
    const s = this.settings;
    const c = this.pipe.engine.cfg;
    const n = (await gallery.active()).length;
    const est = s.calibration ? estimate(s.calibration, s.tauHigh) : null;
    const pct = (v: number) => `${num(v * 100, 1)} %`;
    const pos = (v: number) => ((v - 0.2) / 0.4) * 100;
    return `
      <div class="hero"><small>AJUSTES</small><h1>Privacidad y umbral</h1><p><span class="dot ok"></span> <span id="egress">${this.egress} conexiones salientes en esta sesión</span></p></div>
      <div class="pad">
        <div class="panel">
          ${this.toggle('privacyMode', 'Modo privacidad', 'Apaga cámara y avisos por completo')}
          ${this.toggle('onDemand', 'Sólo a pedido', 'Identifica sólo al presionar «¿Quién es?» (o barra espaciadora)')}
          ${this.toggle('voice', 'Aviso por voz', 'Voz local del sistema; si no hay voz local, no habla')}
          ${this.toggle('announceOnChange', 'Avisar al cambiar de persona', 'Si aparece otra cara, dice quién es sin que preguntes')}
          ${this.toggle('announceUnknown', 'Avisar si no es conocido', '«No es nadie conocido. Podés invitarlo a sumarse al círculo.»')}
          ${this.toggle('listen', 'Escuchar «¿quién es?»', 'Micrófono abierto; Whisper transcribe en el dispositivo, el audio no sale')}
          <small id="mic-detail" class="muted tiny"></small>
          <label class="setting"><div><b>Cámara</b><small>La trasera, a la altura de los ojos, reemplaza a las gafas</small></div>
            <select id="facing"><option value="user" ${s.facing === 'user' ? 'selected' : ''}>Frontal</option><option value="environment" ${s.facing === 'environment' ? 'selected' : ''}>Trasera</option></select></label>
        </div>
        <div class="panel"><small class="label">UMBRAL DE DECISIÓN</small>
          <div class="between"><span>Confirmar identidad desde</span><b>τ = ${num(s.tauHigh)}</b></div>
          <div class="slider"><div class="band" style="left:${pos(c.tauLow)}%;width:${pos(c.tauHigh) - pos(c.tauLow)}%"></div>
            <input type="range" id="tau" min="0.2" max="0.6" step="0.01" value="${s.tauHigh}" /></div>
          <div class="between tiny muted"><span>0,20 permisivo</span><span>banda de abstención</span><span>0,60 estricto</span></div>
          <div class="note">${est
            ? `Galería actual (N = ${n}): <b>FPIR ${pct(est.fpir)} · FNIR ${pct(est.fnir)}</b> estimados con la calibración de N = ${s.calibration!.galleryN}.`
            : `Galería actual (N = ${n}). <b>Sin calibración cargada</b>: corré <code>mnemo-eval</code> en <code>core/</code> y cargá el <code>eval_report.json</code> para ver FPIR/FNIR estimados.`}
            Entre ${num(c.tauLow)} y ${num(c.tauHigh)} el sistema dice «no estoy seguro» antes que arriesgar un nombre.</div>
          <label class="file">Cargar calibración (eval_report.json)<input type="file" id="calib" accept="application/json" /></label>
          <div class="between"><span>Permanencia antes de avisar</span><b id="dwell-v">${num(s.dwellMs / 1000, 1)} s</b></div>
          <input type="range" id="dwell" min="0" max="3000" step="100" value="${s.dwellMs}" />
        </div>
        <div class="panel"><small class="label">RETENCIÓN</small>
          <div class="between"><span>Plantillas biométricas</span><span class="muted">hasta revocación · 12 meses</span></div>
          <div class="between"><span>Historial de encuentros</span><span class="muted">7 días</span></div>
          <div class="between"><span>Imágenes y audio</span><b>nunca</b></div></div>
        <div class="two"><button class="btn ghost" data-act="export">Exportar auditoría</button><button class="btn ghost danger" data-act="wipe">Borrar plantillas</button></div>
      </div>`;
  }

  private toggle(key: ToggleKey, title: string, sub: string) {
    return `<label class="setting"><div><b>${title}</b><small>${sub}</small></div><input type="checkbox" class="switch-input" data-setting="${key}" ${this.settings[key] ? 'checked' : ''}/></label>`;
  }

  private bindScreen(screen: HTMLElement) {
    screen.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
      b.addEventListener('click', () => { this.tab = b.dataset.go as Tab; this.renderPhone(); }));
    screen.querySelectorAll<HTMLElement>('[data-person]').forEach((b) =>
      b.addEventListener('click', async () => { screen.innerHTML = await this.screenPerson(b.dataset.person!); this.bindScreen(screen); }));
    screen.querySelectorAll<HTMLElement>('[data-report]').forEach((b) =>
      b.addEventListener('click', async () => { await history.reportError(Number(b.dataset.report)); this.renderPhone(); }));
    screen.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act!, b.dataset.id)));

    screen.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((inp) =>
      inp.addEventListener('change', async () => {
        const key = inp.dataset.setting as ToggleKey;
        this.settings[key] = inp.checked;
        await saveSettings(this.settings);
        this.applyDecisionSettings();
        this.pipe.engine.reset();
        if (key === 'privacyMode') {
          if (inp.checked) { this.stopCamera(); this.listener.stop(); this.renderPrivacyOverlay(); }
          else { await this.startCamera(); if (this.settings.listen) this.startListening(); }
        }
        if (key === 'listen') {
          if (inp.checked && !this.settings.privacyMode) this.startListening();
          else this.listener.stop();
        }
      }));
    const facing = screen.querySelector<HTMLSelectElement>('#facing');
    facing?.addEventListener('change', async () => {
      this.settings.facing = facing.value as Settings['facing'];
      await saveSettings(this.settings);
      if (!this.settings.privacyMode) await this.startCamera();
    });
    const tau = screen.querySelector<HTMLInputElement>('#tau');
    tau?.addEventListener('change', async () => {
      this.settings.tauHigh = Number(tau.value);
      await saveSettings(this.settings);
      this.applyDecisionSettings();
      this.renderPhone();
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
      } catch (e) {
        alert(`Archivo de calibración inválido: ${(e as Error).message}`);
      }
      this.renderPhone();
    });
  }

  private async act(action: string, id?: string) {
    if (action === 'invite') return this.enroll();
    if (action === 'regen' && id) return this.enroll(id);
    if (action === 'save-person' && id) {
      const phrase = $<HTMLInputElement>('#phrase').value.trim();
      const notes = document.querySelector<HTMLTextAreaElement>('#notes');
      const context = document.querySelector<HTMLInputElement>('#context');
      await gallery.update(id, {
        phrase,
        ...(notes ? { notes: notes.value.split('\n').map((l) => l.trim()).filter(Boolean) } : {}),
        ...(context ? { context: context.value.trim() } : {}),
      });
      this.tab = 'circulo';
      return this.renderPhone();
    }
    if (action === 'revoke' && id) {
      const i = await gallery.getIdentity(id);
      if (!confirm(`¿Revocar el consentimiento de ${i?.name}? La plantilla, las notas y sus registros se borran de forma irreversible.`)) return;
      await gallery.revoke(id);
      await history.forgetIdentity(id);
      this.pipe.engine.reset();
      this.tab = 'circulo';
      return this.renderPhone();
    }
    if (action === 'wipe') {
      if (!confirm('¿Borrar TODAS las plantillas? Es irreversible.')) return;
      for (const i of await gallery.list()) await history.forgetIdentity(i.id);
      await gallery.wipeAll();
      this.pipe.engine.reset();
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

  // ---------------------------------------------------------------- alta con consentimiento (CU-01)
  private async enroll(replaceId?: string) {
    if (!this.source || this.settings.privacyMode) {
      alert('Desactivá el modo privacidad para enrolar: la captura guiada necesita la cámara.');
      return;
    }
    this.enrolling = true;
    $('.stage').dataset.view = 'phone';
    this.root.querySelectorAll('.switch button').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.view === 'phone'));
    const screen = $('#screen');
    const replacing = replaceId ? await gallery.getIdentity(replaceId) : undefined;
    const finish = async () => {
      this.enrolling = false;
      this.pipe.engine.reset();
      await this.renderPhone();
    };

    // P-02 · Invitación
    const code = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    screen.innerHTML = `
      <div class="hero"><small>PASO 1 DE 3 · INVITACIÓN</small><h1>${replacing ? `Renovar a ${esc(replacing.name)}` : 'Invitar al círculo'}</h1><p>El alta la completa la persona invitada</p></div>
      <div class="pad">
        <div class="panel center"><div class="qr">${fakeQr(code)}</div><b>Código de un solo uso · MN-${code}</b><small class="muted">Vence en ${ENROLLMENT.inviteTtlHours} horas y sirve una sola vez</small></div>
        <div class="panel"><small class="label">QUÉ VA A PASAR</small>
          <ol class="steps"><li>Lee y acepta el consentimiento en <b>su</b> dispositivo.</li><li>Toma 5 fotos guiadas; se convierten en un vector de 512 números y las imágenes se descartan.</li><li>La plantilla queda cifrada en el dispositivo del portador y sólo ahí.</li></ol></div>
        <div class="note"><b>Demo web:</b> el alta ocurre en este mismo navegador. En la app real el invitado escanea el QR y todo el flujo corre en su teléfono.</div>
        <button class="btn block" id="go">Continuar como la persona invitada</button>
        <button class="btn block ghost" id="cancel">Cancelar</button>
      </div>`;
    const step1 = await new Promise<boolean>((r) => {
      $('#go', screen).onclick = () => r(true);
      $('#cancel', screen).onclick = () => r(false);
    });
    if (!step1) return finish();

    // P-04 · Consentimiento (antecede a la captura)
    screen.innerHTML = `
      <div class="hero"><small>PASO 2 DE 3 · CONSENTIMIENTO</small><h1>Tu cara, tus reglas</h1><p>Leé antes de aceptar</p></div>
      <div class="pad">
        <div class="panel legal">
          <p><b>Finalidad.</b> Ayudar a quien usa las gafas a recordar quién sos cuando se encuentran, mediante un aviso privado por el auricular.</p>
          <p><b>Qué se guarda.</b> Un vector numérico (plantilla biométrica) derivado de tu rostro, cifrado en el almacén seguro del dispositivo. <b>No se guardan fotos ni video.</b></p>
          <p><b>Dónde se procesa.</b> Todo el reconocimiento ocurre en el dispositivo, sin enviar datos a servidores ni a terceros.</p>
          <p><b>Quién accede.</b> El portador y su cuidador/a. Nadie más.</p>
          <p><b>Plazo.</b> Tu autorización vence en 12 meses y se te vuelve a pedir.</p>
          <p><b>Revocación.</b> Podés revocarla cuando quieras; la plantilla se borra de forma irreversible.</p>
        </div>
        <div class="panel">
          <label class="setting"><div><b>Uso de mi rostro para que me nombre</b><small>Nombre y vínculo al oído</small></div><input type="checkbox" class="switch-input" id="c-id" checked /></label>
          <label class="setting"><div><b>Notas de conversación</b><small>Ej.: «vive en Rosario»</small></div><input type="checkbox" class="switch-input" id="c-notes" checked /></label>
          <label class="setting"><div><b>Registro de nuestros encuentros</b><small>7 días, sin imágenes</small></div><input type="checkbox" class="switch-input" id="c-log" /></label>
        </div>
        <button class="btn block" id="accept">Acepto y me enrolo</button>
        <button class="btn block ghost" id="decline">No, gracias</button>
        <small class="muted tiny center-t">Ley 25.326, arts. 4, 5 y 9 · consentimiento libre, expreso e informado</small>
      </div>`;
    const consent = await new Promise<gallery.Consent | null>((r) => {
      $('#accept', screen).onclick = () => r({
        identification: $<HTMLInputElement>('#c-id', screen).checked,
        notes: $<HTMLInputElement>('#c-notes', screen).checked,
        encounterLog: $<HTMLInputElement>('#c-log', screen).checked,
      });
      $('#decline', screen).onclick = () => r(null);
    });
    if (!consent || !consent.identification) {
      // CU-01 A1: no se captura ninguna imagen y la invitación se invalida.
      alert('Rechazado: no se capturó ninguna imagen y la invitación quedó invalidada.');
      return finish();
    }

    // P-03 · Captura guiada
    const vecs = await this.guidedCapture(screen);
    if (!vecs) return finish();
    if (!vecs.length) {
      alert('No hubo tomas válidas: no se creó ninguna plantilla.');
      return finish();
    }
    const template = centroid(vecs);
    vecs.length = 0; // los vectores por toma también se descartan: sólo queda el centroide

    if (replacing) {
      await gallery.revoke(replacing.id, 'regeneracion');
      await gallery.enroll({
        name: replacing.name, relation: replacing.relation, phrase: replacing.phrase, context: replacing.context,
        template, consent, validShots: this.lastValidShots,
      });
      return finish();
    }

    // P-05 · Ficha (completa el cuidador)
    screen.innerHTML = `
      <div class="hero"><small>FICHA NUEVA</small><h1>¿Quién es?</h1><p>Lo completa el cuidador</p></div>
      <div class="pad"><div class="panel form">
        <label>Nombre<input id="f-name" placeholder="Marta" required /></label>
        <label>Vínculo<input id="f-rel" placeholder="tu hija" required /></label>
        <label>Frase del aviso<input id="f-phrase" placeholder="Es Marta, tu hija." /></label>
        ${consent.notes ? '<label>Dato de contexto (opcional)<input id="f-ctx" placeholder="vive en Rosario" /></label>' : '<small class="muted">Consentimiento parcial: la ficha queda sin notas.</small>'}
      </div><button class="btn block" id="save">Guardar en el círculo</button></div>`;
    const name = $<HTMLInputElement>('#f-name', screen);
    const rel = $<HTMLInputElement>('#f-rel', screen);
    const phrase = $<HTMLInputElement>('#f-phrase', screen);
    const sync = () => { phrase.placeholder = `Es ${name.value || 'Marta'}, ${rel.value || 'tu hija'}.`; };
    name.oninput = rel.oninput = sync;
    await new Promise<void>((r) => {
      $('#save', screen).onclick = () => {
        if (!name.value.trim() || !rel.value.trim()) { name.focus(); return; }
        r();
      };
    });
    await gallery.enroll({
      name: name.value.trim(), relation: rel.value.trim(), phrase: phrase.value.trim() || undefined,
      context: document.querySelector<HTMLInputElement>('#f-ctx')?.value.trim(), template, consent,
      validShots: this.lastValidShots,
    });
    this.tab = 'circulo';
    return finish();
  }

  private lastValidShots = 0;

  /** Cinco tomas guiadas con verificación de detección, tamaño y nitidez. Devuelve vectores o null si se cancela. */
  private async guidedCapture(screen: HTMLElement): Promise<Float32Array[] | null> {
    const shots = ENROLLMENT.shots;
    screen.innerHTML = `
      <div class="capture">
        <small class="cap-h">PASO 3 DE 3 · CAPTURA GUIADA</small>
        <div class="cap-view"><canvas id="cap-canvas"></canvas><div class="oval"></div></div>
        <h2 id="cap-hint">${shots[0].hint}</h2><p id="cap-sub" class="muted">Toma 1 de 5</p>
        <div class="shots">${shots.map((s, k) => `<div class="shot" data-k="${k}"><span>○</span>${s.label}</div>`).join('')}</div>
        <div class="two"><button class="btn ghost" id="skip">Omitir toma</button><button class="btn ghost" id="abort">Cancelar</button></div>
        <div class="note dark">Las fotos <b>no se guardan</b>. Cada toma produce un vector de 512 números; la imagen se borra de la memoria al instante.</div>
      </div>`;
    const canvas = $<HTMLCanvasElement>('#cap-canvas', screen);
    const vecs: Float32Array[] = [];
    let k = 0, stable = 0, skip = false, abort = false, firstProfileSign = 0;
    $('#skip', screen).onclick = () => { skip = true; };
    $('#abort', screen).onclick = () => { abort = true; };
    const mark = (i: number, ok: boolean) => {
      const el = screen.querySelector(`.shot[data-k="${i}"]`)!;
      el.classList.add(ok ? 'ok' : 'skipped');
      el.querySelector('span')!.textContent = ok ? '✓' : '–';
    };
    const frame = document.createElement('canvas');

    while (k < shots.length) {
      if (abort) return null;
      screen.querySelectorAll('.shot').forEach((el, i) => el.classList.toggle('on', i === k));
      $('#cap-hint', screen).textContent = shots[k].hint;
      if (skip) { mark(k, false); k++; skip = false; stable = 0; continue; }
      if (!this.source.grab(frame)) { await new Promise((r) => requestAnimationFrame(r)); continue; }
      const isProfile = shots[k].key.startsWith('perfil');
      const a = await this.pipe.analyze(frame, { allowProfile: isProfile });
      drawFrame(canvas, frame, a.face ? { face: a.face, quality: a.quality, zone: a.quality?.ok ? 'match' : 'reject' } as FrameResult : null, this.settings.facing === 'user');

      let why = a.face ? a.quality!.reason : 'no se detecta un rostro';
      if (!why && a.face) {
        const yaw = a.quality!.yaw;
        if (!isProfile && Math.abs(yaw) > 0.2) why = 'mirá de frente';
        if (isProfile) {
          if (Math.abs(yaw) < 0.15) why = 'girá un poco más';
          else if (firstProfileSign && Math.sign(yaw) === firstProfileSign) why = 'ahora hacia el otro lado';
        }
      }
      if (a.faces > 1) why = 'sólo una persona frente a la cámara';
      $('#cap-sub', screen).textContent = why ? `Toma ${k + 1} de 5 · ${why}` : `Toma ${k + 1} de 5 · mantené la posición`;
      stable = why || !a.embedding ? 0 : stable + 1;
      if (stable >= 3 && a.embedding) {
        vecs.push(a.embedding);
        if (isProfile && !firstProfileSign) firstProfileSign = Math.sign(a.quality!.yaw);
        mark(k, true);
        k++;
        stable = 0;
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    frame.width = frame.height = 0;
    this.lastValidShots = vecs.length;
    if (vecs.length && vecs.length < ENROLLMENT.minValidShots) {
      alert(`Sólo ${vecs.length} tomas válidas: la plantilla se marca de baja calidad y su umbral se eleva (CU-01 A2).`);
    }
    return vecs;
  }
}

/** Lee el reporte de `mnemo-eval` y elige la curva DET de la galería más cercana al tamaño actual. */
async function parseCalibration(text: string, n: number): Promise<Calibration> {
  const rep = JSON.parse(text) as Record<string, { det: { tau: number[]; fpir: number[]; fnir: number[] }; N_test: number }>;
  const entries = Object.values(rep).filter((r) => r?.det?.tau?.length);
  if (!entries.length) throw new Error('no contiene curvas DET');
  const best = entries.reduce((a, b) => (Math.abs(b.N_test - n) < Math.abs(a.N_test - n) ? b : a));
  return { ...best.det, galleryN: best.N_test };
}

/** QR decorativo (determinista a partir del código). La app real genera un QR de verdad con el token firmado. */
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
