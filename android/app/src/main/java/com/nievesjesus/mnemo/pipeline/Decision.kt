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

fun classify(s: Float, lo: Float, hi: Float) = when {
  s >= hi -> Zone.MATCH
  s >= lo -> Zone.ABSTAIN
  else -> Zone.REJECT
}

data class Announcement(val kind: Zone, val identityId: String?, val sMax: Float, val hits: Int, val window: Int, val latencyMs: Long)

/** Etapa 07 · decisión con rechazo + confirmación temporal 3 de 4 + una frase por encuentro (RN-08). */
class DecisionEngine(val cfg: DecisionConfig = DecisionConfig()) {
  var state = State.EN_REPOSO
    private set
  private val window = ArrayDeque<Triple<Zone, String?, Float>>()
  private var firstSeen: Long? = null
  private var lastSeen: Long? = null
  private var failed = 0
  private var announced = false

  fun reset() {
    state = State.EN_REPOSO
    window.clear()
    firstSeen = null; lastSeen = null
    failed = 0
    announced = false
  }

  fun thresholds(weak: Boolean) = cfg.tauLow to cfg.tauHigh + if (weak) cfg.weakTemplatePenalty else 0f

  fun step(tMs: Long, facePresent: Boolean, usable: Boolean, identityId: String? = null, sMax: Float = -1f, weak: Boolean = false): Announcement? {
    if (!facePresent) {
      val last = lastSeen
      if (last != null && tMs - last > cfg.encounterGapMs) reset() else if (!announced) state = State.EN_REPOSO
      return null
    }
    val first = firstSeen ?: tMs.also { firstSeen = it }
    lastSeen = tMs
    if (announced) return null
    if (!usable) {
      if (++failed >= cfg.maxFailedFrames) { window.clear(); failed = 0; firstSeen = tMs }
      return null
    }
    failed = 0
    val (lo, hi) = thresholds(weak)
    val zone = classify(sMax, lo, hi)
    window.addLast(Triple(zone, if (zone == Zone.MATCH) identityId else null, sMax))
    if (window.size > cfg.confirmWindow) window.removeFirst()
    state = if (window.all { it.first == Zone.REJECT }) State.DESCARTANDO else State.OBSERVANDO
    if (window.size < cfg.confirmHits || tMs - first < cfg.dwellMs) return null

    val votes = window.mapNotNull { it.second }.groupingBy { it }.eachCount()
    val best = votes.maxByOrNull { it.value }
    if (best != null && best.value >= cfg.confirmHits) {
      state = State.AFIRMANDO; announced = true
      return Announcement(Zone.MATCH, best.key, window.filter { it.second == best.key }.maxOf { it.third }, best.value, window.size, tMs - first)
    }
    val nonReject = window.count { it.first != Zone.REJECT }
    if (window.size == cfg.confirmWindow && nonReject >= cfg.confirmHits) {
      state = State.ABSTENIENDOSE; announced = true
      return Announcement(Zone.ABSTAIN, null, window.maxOf { it.third }, nonReject, window.size, tMs - first)
    }
    return null
  }
}
