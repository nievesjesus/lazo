package com.nievesjesus.mnemo.pipeline

/** Parámetros por defecto: iguales a core/mnemo/config.py y web/src/pipeline/config.ts. */
data class DecisionConfig(
    var tauLow: Float = 0.30f,
    var tauHigh: Float = 0.38f,
    val weakTemplatePenalty: Float = 0.05f,
    val confirmWindow: Int = 4,
    val confirmHits: Int = 3,
    var dwellMs: Long = 1500,
    val encounterGapMs: Long = 8000,
    val maxFailedFrames: Int = 3,
    /** Coseno mínimo con el rostro anunciado para seguir siendo «la misma persona». */
    val changeThreshold: Float = 0.45f,
    /** Cuadros seguidos por debajo ⇒ cambio de persona ⇒ encuentro nuevo. */
    val changeFrames: Int = 3,
    /** Al cambiar de persona, avisar sin que pregunten. */
    var announceOnChange: Boolean = true,
    /** Decir «no es nadie conocido» sin que pregunten (a pedido, siempre). */
    var announceUnknown: Boolean = true,
)

object Quality {
  const val MIN_FACE_PX = 80f
  const val MIN_SHARPNESS = 60f
  const val MIN_BRIGHTNESS = 40f
  const val MAX_BRIGHTNESS = 220f
  const val MIN_DET_SCORE = 0.5f
  const val MAX_YAW = 0.35f
}

enum class State { EN_REPOSO, OBSERVANDO, AFIRMANDO, ABSTENIENDOSE, DESCARTANDO }

enum class Zone { MATCH, ABSTAIN, REJECT }

enum class Reason { ENCUENTRO, CAMBIO, PEDIDO }

fun classify(s: Float, lo: Float, hi: Float) = when {
  s >= hi -> Zone.MATCH
  s >= lo -> Zone.ABSTAIN
  else -> Zone.REJECT
}

/** kind: MATCH ⇒ nombrar · ABSTAIN ⇒ «no estoy seguro» · REJECT ⇒ «no es nadie conocido». */
data class Announcement(
    val kind: Zone, val identityId: String?, val sMax: Float, val hits: Int, val window: Int, val latencyMs: Long,
    val reason: Reason = Reason.ENCUENTRO,
)

/**
 * Etapa 07 · decisión con rechazo + confirmación 3 de 4. Un encuentro produce a lo sumo una frase
 * (RN-08) y termina sin rostro durante `encounterGapMs` o cuando CAMBIA LA PERSONA: el embedding
 * del cuadro deja de parecerse al del rostro anunciado durante `changeFrames` cuadros seguidos.
 */
class DecisionEngine(val cfg: DecisionConfig = DecisionConfig()) {
  var state = State.EN_REPOSO
    private set
  private val window = ArrayDeque<Triple<Zone, String?, Float>>()
  private var firstSeen: Long? = null
  private var lastSeen: Long? = null
  private var failed = 0
  private var announced = false
  private var anchor: FloatArray? = null
  private var changeCount = 0
  private var skipDwell = false
  private var reason = Reason.ENCUENTRO
  private var silent = false

  fun reset() {
    state = State.EN_REPOSO
    window.clear()
    firstSeen = null; lastSeen = null
    failed = 0
    announced = false
    anchor = null; changeCount = 0
    skipDwell = false; reason = Reason.ENCUENTRO; silent = false
  }

  /** «¿Quién es?»: encuentro nuevo inmediato, sin permanencia mínima, que siempre responde. */
  fun request() {
    reset()
    skipDwell = true
    reason = Reason.PEDIDO
  }

  fun thresholds(weak: Boolean) = cfg.tauLow to cfg.tauHigh + if (weak) cfg.weakTemplatePenalty else 0f

  private fun newEncounter(tMs: Long) {
    window.clear(); failed = 0; firstSeen = tMs
    announced = false; anchor = null; changeCount = 0
    skipDwell = true; reason = Reason.CAMBIO; silent = !cfg.announceOnChange
    state = State.OBSERVANDO
  }

  private fun tracksChange(emb: FloatArray): Boolean {
    val a = anchor ?: run { anchor = emb.copyOf(); return false }
    if (dot(a, emb) >= cfg.changeThreshold) {
      changeCount = 0
      for (i in a.indices) a[i] = 0.85f * a[i] + 0.15f * emb[i] // acompaña cambios de pose y luz
      anchor = l2normalize(a)
      return false
    }
    return ++changeCount >= cfg.changeFrames
  }

  private fun emit(a: Announcement, emb: FloatArray?): Announcement? {
    announced = true
    anchor = emb?.copyOf()
    changeCount = 0
    val quiet = reason != Reason.PEDIDO && (silent || (a.kind == Zone.REJECT && !cfg.announceUnknown))
    return if (quiet) null else a.copy(reason = reason)
  }

  fun step(
      tMs: Long, facePresent: Boolean, usable: Boolean, identityId: String? = null, sMax: Float = -1f,
      weak: Boolean = false, embedding: FloatArray? = null,
  ): Announcement? {
    if (!facePresent) {
      val last = lastSeen
      if (last != null && tMs - last > cfg.encounterGapMs) reset() else if (!announced) state = State.EN_REPOSO
      return null
    }
    if (firstSeen == null) firstSeen = tMs
    lastSeen = tMs
    if (announced) {
      if (usable && embedding != null && tracksChange(embedding)) newEncounter(tMs) else return null
    }
    if (!usable) {
      if (++failed >= cfg.maxFailedFrames) { window.clear(); failed = 0; firstSeen = tMs }
      return null
    }
    failed = 0
    val first = firstSeen!!
    val (lo, hi) = thresholds(weak)
    val zone = classify(sMax, lo, hi)
    window.addLast(Triple(zone, if (zone == Zone.MATCH) identityId else null, sMax))
    if (window.size > cfg.confirmWindow) window.removeFirst()
    state = if (window.all { it.first == Zone.REJECT }) State.DESCARTANDO else State.OBSERVANDO
    if (window.size < cfg.confirmHits || (!skipDwell && tMs - first < cfg.dwellMs)) return null
    val latency = tMs - first

    val best = window.mapNotNull { it.second }.groupingBy { it }.eachCount().maxByOrNull { it.value }
    if (best != null && best.value >= cfg.confirmHits) {
      state = State.AFIRMANDO
      val s = window.filter { it.second == best.key }.maxOf { it.third }
      return emit(Announcement(Zone.MATCH, best.key, s, best.value, window.size, latency), embedding)
    }
    if (window.size < cfg.confirmWindow) return null
    val rejects = window.count { it.first == Zone.REJECT }
    val s = window.maxOf { it.third }
    if (window.size - rejects >= cfg.confirmHits) {
      state = State.ABSTENIENDOSE
      return emit(Announcement(Zone.ABSTAIN, null, s, window.size - rejects, window.size, latency), embedding)
    }
    if (rejects >= cfg.confirmHits) {
      state = State.DESCARTANDO
      return emit(Announcement(Zone.REJECT, null, s, rejects, window.size, latency), embedding)
    }
    return null
  }
}
