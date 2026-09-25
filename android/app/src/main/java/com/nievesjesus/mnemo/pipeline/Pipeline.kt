package com.nievesjesus.mnemo.pipeline

import android.content.Context
import android.graphics.Bitmap
import com.nievesjesus.mnemo.store.Identity
import com.nievesjesus.mnemo.store.SecureGallery
import kotlin.math.abs

const val ABSTAIN_PHRASE = "Hay alguien, pero no lo reconozco."
const val UNKNOWN_PHRASE = "No es nadie conocido. Podés invitarlo a sumarse al círculo."
const val NOBODY_PHRASE = "No veo a nadie frente a vos."
const val UNCLEAR_PHRASE = "No logro ver bien la cara."

data class QualityReport(val ok: Boolean, val reason: String?, val sharpness: Float, val brightness: Float, val facePx: Float, val yaw: Float)

data class Analysis(val face: Face?, val quality: QualityReport?, val embedding: FloatArray?, val faces: Int)

data class FrameResult(
    val face: Face?,
    val quality: QualityReport?,
    val candidate: Identity?,
    val sMax: Float,
    val zone: Zone?,
    val state: State,
    val announcement: Announcement?,
    val phrase: String?,
    val totalMs: Long,
)

/** Pipeline de ocho etapas (figura 7). El Bitmap de entrada no se retiene (RN-02). */
class Pipeline(ctx: Context, private val gallery: SecureGallery, cfg: DecisionConfig = DecisionConfig()) : AutoCloseable {
  private val detector = FaceDetector(ctx)
  private val embedder = FaceEmbedder(ctx)
  private val crop = Bitmap.createBitmap(112, 112, Bitmap.Config.ARGB_8888)
  val engine = DecisionEngine(cfg)

  fun analyze(frame: Bitmap, allowProfile: Boolean = false): Analysis {
    val img = gammaCorrect(frame)
    val faces = detector.detect(img, Quality.MIN_DET_SCORE)
    val face = faces.firstOrNull()
    if (face == null) {
      if (img !== frame) img.recycle()
      return Analysis(null, null, null, 0)
    }
    alignCrop(img, face.kps, crop)
    if (img !== frame) img.recycle()
    val g = gray(crop)
    val sh = sharpness(g, 112, 112)
    val br = g.average().toFloat()
    val yaw = yawRatio(face.kps)
    val reason = when {
      face.height < Quality.MIN_FACE_PX -> "rostro pequeño"
      sh < Quality.MIN_SHARPNESS -> "borroso"
      br < Quality.MIN_BRIGHTNESS -> "poca luz"
      br > Quality.MAX_BRIGHTNESS -> "sobreexpuesto"
      !allowProfile && abs(yaw) > Quality.MAX_YAW -> "de perfil"
      else -> null
    }
    val q = QualityReport(reason == null, reason, sh, br, face.height, yaw)
    return Analysis(face, q, if (q.ok) embedder.embed(crop) else null, faces.size)
  }

  fun process(frame: Bitmap, tMs: Long): FrameResult {
    val t0 = System.nanoTime()
    val a = analyze(frame)
    fun done(cand: Identity? = null, s: Float = -1f, zone: Zone? = null, ann: Announcement? = null, phrase: String? = null) =
        FrameResult(a.face, a.quality, cand, s, zone, engine.state, ann, phrase, (System.nanoTime() - t0) / 1_000_000)

    if (a.face == null) { engine.step(tMs, facePresent = false, usable = false); return done() }
    val emb = a.embedding ?: run { engine.step(tMs, facePresent = true, usable = false); return done() }

    val (best, sMax) = gallery.search(emb)
    val weak = best?.isWeak == true
    val (lo, hi) = engine.thresholds(weak)
    val zone = classify(sMax, lo, hi)
    val ann = engine.step(tMs, true, true, best?.id, sMax, weak, emb)
    val phrase = when (ann?.kind) {
      Zone.MATCH -> gallery.get(ann.identityId!!)?.phrase
      Zone.ABSTAIN -> ABSTAIN_PHRASE
      Zone.REJECT -> UNKNOWN_PHRASE
      null -> null
    }
    return done(best, sMax, zone, ann, phrase)
  }

  override fun close() {
    detector.close()
    embedder.close()
  }
}
