package com.nievesjesus.mnemo.pipeline

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin

/** Canonical ArcFace template on 112×112. */
val ARCFACE_TEMPLATE = arrayOf(
    floatArrayOf(38.2946f, 51.6963f), floatArrayOf(73.5318f, 51.5014f), floatArrayOf(56.0252f, 71.7366f),
    floatArrayOf(41.5493f, 92.3655f), floatArrayOf(70.7299f, 92.2041f))

/** Stage 04 · 4-DoF least-squares similarity transform (2D Umeyama, closed form). [a, b, tx, c, d, ty]. */
fun similarityTransform(src: Array<FloatArray>, dst: Array<FloatArray> = ARCFACE_TEMPLATE): FloatArray {
  val n = src.size
  var msx = 0.0; var msy = 0.0; var mdx = 0.0; var mdy = 0.0
  for (i in 0 until n) { msx += src[i][0]; msy += src[i][1]; mdx += dst[i][0]; mdy += dst[i][1] }
  msx /= n; msy /= n; mdx /= n; mdy /= n
  var sxx = 0.0; var sxy = 0.0; var varS = 0.0
  for (i in 0 until n) {
    val x = src[i][0] - msx; val y = src[i][1] - msy
    val u = dst[i][0] - mdx; val v = dst[i][1] - mdy
    sxx += x * u + y * v
    sxy += x * v - y * u
    varS += x * x + y * y
  }
  val theta = atan2(sxy, sxx)
  val s = hypot(sxx, sxy) / varS
  val a = s * cos(theta); val c = s * sin(theta)
  val tx = mdx - (a * msx - c * msy)
  val ty = mdy - (c * msx + a * msy)
  return floatArrayOf(a.toFloat(), (-c).toFloat(), tx.toFloat(), c.toFloat(), a.toFloat(), ty.toFloat())
}

fun alignCrop(src: Bitmap, kps: Array<FloatArray>, out: Bitmap = Bitmap.createBitmap(112, 112, Bitmap.Config.ARGB_8888)): Bitmap {
  val m = similarityTransform(kps)
  val canvas = Canvas(out)
  canvas.drawColor(Color.BLACK)
  canvas.drawBitmap(src, Matrix().apply { setValues(floatArrayOf(m[0], m[1], m[2], m[3], m[4], m[5], 0f, 0f, 1f)) }, Paint(Paint.FILTER_BITMAP_FLAG))
  return out
}

fun gray(bmp: Bitmap): FloatArray {
  val px = IntArray(bmp.width * bmp.height).also { bmp.getPixels(it, 0, bmp.width, 0, 0, bmp.width, bmp.height) }
  return FloatArray(px.size) { val p = px[it]; 0.299f * ((p shr 16) and 0xff) + 0.587f * ((p shr 8) and 0xff) + 0.114f * (p and 0xff) }
}

/** V = Var(∇²I) with the mask [[0,1,0],[1,−4,1],[0,1,0]] (variance of the Laplacian). */
fun sharpness(g: FloatArray, w: Int, h: Int): Float {
  var sum = 0.0; var sum2 = 0.0; var n = 0
  for (y in 1 until h - 1) for (x in 1 until w - 1) {
    val i = y * w + x
    val l = (g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i]).toDouble()
    sum += l; sum2 += l * l; n++
  }
  val mean = sum / n
  return (sum2 / n - mean * mean).toFloat()
}

/** Power-law intensity correction toward a target mean (stage 02). */
fun gammaCorrect(src: Bitmap, target: Float = 120f): Bitmap {
  val g = gray(src)
  val mean = (g.average().toFloat().coerceAtLeast(1f)) / 255f
  val gamma = (ln(target / 255f) / ln(mean)).coerceIn(0.4f, 2.5f)
  if (kotlin.math.abs(gamma - 1f) < 0.05f) return src
  val lut = IntArray(256) { ((it / 255f).pow(gamma) * 255f).toInt().coerceIn(0, 255) }
  val px = IntArray(src.width * src.height).also { src.getPixels(it, 0, src.width, 0, 0, src.width, src.height) }
  for (i in px.indices) {
    val p = px[i]
    px[i] = (p and 0xff000000.toInt()) or (lut[(p shr 16) and 0xff] shl 16) or (lut[(p shr 8) and 0xff] shl 8) or lut[p and 0xff]
  }
  return Bitmap.createBitmap(px, src.width, src.height, Bitmap.Config.ARGB_8888)
}

fun yawRatio(k: Array<FloatArray>): Float {
  val mx = (k[0][0] + k[1][0]) / 2
  val iod = hypot(k[1][0] - k[0][0], k[1][1] - k[0][1]) + 1e-6f
  return (k[2][0] - mx) / iod
}
