package com.nievesjesus.mnemo.pipeline

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import java.nio.FloatBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

data class Face(val box: FloatArray, val score: Float, val kps: Array<FloatArray>) {
  val height get() = box[3] - box[1]
}

private fun session(env: OrtEnvironment, ctx: Context, asset: String): OrtSession {
  val bytes = ctx.assets.open(asset).use { it.readBytes() }
  val opts = OrtSession.SessionOptions().apply {
    setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
    // NNAPI (tabla 7): permite comparar CPU vs. acelerador sin cambiar el modelo.
    runCatching { addNnapi() }
  }
  return env.createSession(bytes, opts)
}

/** Etapa 03 · RetinaFace-500MF (SCRFD). Misma decodificación que core/mnemo/detector.py. */
class FaceDetector(ctx: Context, private val size: Int = 640) : AutoCloseable {
  private val env = OrtEnvironment.getEnvironment()
  private val sess = session(env, ctx, "models/det_500m.onnx")
  private val strides = intArrayOf(8, 16, 32)
  private val canvasBmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)

  fun detect(src: Bitmap, scoreThresh: Float = 0.5f): List<Face> {
    val scale = size.toFloat() / max(src.width, src.height)
    val c = Canvas(canvasBmp)
    c.drawColor(Color.BLACK)
    c.drawBitmap(src, Matrix().apply { postScale(scale, scale) }, Paint(Paint.FILTER_BITMAP_FLAG))
    val px = IntArray(size * size).also { canvasBmp.getPixels(it, 0, size, 0, 0, size, size) }
    val plane = size * size
    val input = FloatArray(3 * plane)
    for (j in 0 until plane) {
      val p = px[j]
      input[j] = (((p shr 16) and 0xff) - 127.5f) / 128f
      input[j + plane] = (((p shr 8) and 0xff) - 127.5f) / 128f
      input[j + 2 * plane] = ((p and 0xff) - 127.5f) / 128f
    }
    val faces = ArrayList<Face>()
    OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, 3, size.toLong(), size.toLong())).use { t ->
      sess.run(mapOf(sess.inputNames.first() to t)).use { out ->
        strides.forEachIndexed { si, stride ->
          @Suppress("UNCHECKED_CAST")
          val scores = out[si].value as Array<FloatArray>
          @Suppress("UNCHECKED_CAST")
          val boxes = out[si + 3].value as Array<FloatArray>
          @Suppress("UNCHECKED_CAST")
          val kps = out[si + 6].value as Array<FloatArray>
          val fw = size / stride
          for (k in scores.indices) {
            val s = scores[k][0]
            if (s < scoreThresh) continue
            val cell = k / 2
            val cx = (cell % fw) * stride.toFloat()
            val cy = (cell / fw) * stride.toFloat()
            val b = boxes[k]
            val box = floatArrayOf(
                (cx - b[0] * stride) / scale, (cy - b[1] * stride) / scale,
                (cx + b[2] * stride) / scale, (cy + b[3] * stride) / scale)
            val pts = Array(5) { p -> floatArrayOf((cx + kps[k][2 * p] * stride) / scale, (cy + kps[k][2 * p + 1] * stride) / scale) }
            faces += Face(box, s, pts)
          }
        }
      }
    }
    return nms(faces).sortedByDescending { it.height } // CU-02 A3: el más cercano primero
  }

  private fun nms(faces: List<Face>, thresh: Float = 0.4f): List<Face> {
    val keep = ArrayList<Face>()
    for (f in faces.sortedByDescending { it.score }) if (keep.none { iou(it.box, f.box) > thresh }) keep += f
    return keep
  }

  private fun iou(a: FloatArray, b: FloatArray): Float {
    val iw = max(0f, min(a[2], b[2]) - max(a[0], b[0]))
    val ih = max(0f, min(a[3], b[3]) - max(a[1], b[1]))
    val inter = iw * ih
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9f)
  }

  override fun close() = sess.close()
}

/** Etapa 05 · MobileFaceNet (ArcFace, WebFace600K) → vector de 512 normalizado. */
class FaceEmbedder(ctx: Context) : AutoCloseable {
  private val env = OrtEnvironment.getEnvironment()
  private val sess = session(env, ctx, "models/w600k_mbf.onnx")

  fun embed(crop112: Bitmap): FloatArray {
    val plane = 112 * 112
    val px = IntArray(plane).also { crop112.getPixels(it, 0, 112, 0, 0, 112, 112) }
    val input = FloatArray(3 * plane)
    for (j in 0 until plane) {
      val p = px[j]
      input[j] = (((p shr 16) and 0xff) - 127.5f) / 127.5f
      input[j + plane] = (((p shr 8) and 0xff) - 127.5f) / 127.5f
      input[j + 2 * plane] = ((p and 0xff) - 127.5f) / 127.5f
    }
    return OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, 3, 112, 112)).use { t ->
      sess.run(mapOf(sess.inputNames.first() to t)).use { out ->
        @Suppress("UNCHECKED_CAST")
        l2normalize((out[0].value as Array<FloatArray>)[0])
      }
    }
  }

  override fun close() = sess.close()
}

fun l2normalize(v: FloatArray): FloatArray {
  var n = 0f
  for (x in v) n += x * x
  n = sqrt(n) + 1e-12f
  return FloatArray(v.size) { v[it] / n }
}

fun dot(a: FloatArray, b: FloatArray): Float {
  var s = 0f
  for (i in a.indices) s += a[i] * b[i]
  return s
}

/** RF-04: centroide normalizado de las tomas válidas. */
fun centroid(vs: List<FloatArray>): FloatArray {
  val c = FloatArray(vs.first().size)
  for (v in vs) for (i in c.indices) c[i] += v[i]
  return l2normalize(c)
}
