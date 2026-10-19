package com.nievesjesus.mnemo.capture

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.VideoFrame
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Frames from the Ray-Ban Meta glasses through the Meta Wearables Device Access Toolkit (1.0).
 *
 * Preconditions (handled by [com.nievesjesus.mnemo.MainActivity]):
 *  1. `Wearables.initialize(context)` after BLUETOOTH_CONNECT / INTERNET are granted.
 *  2. Registration with the Meta AI app (`Wearables.startRegistration`) and Developer Mode on.
 *  3. Glasses camera permission (`Wearables.RequestPermissionContract`, Permission.CAMERA).
 *
 * The stream is requested uncompressed: the SDK delivers decoded YUV (I420 in the official sample;
 * the buffer size is validated in case that changes). 504×896 at 15 fps is enough for faces > 80 px
 * at conversation distance and leaves battery headroom (energy budget ≤ 12 %/h).
 */
class GlassesCameraSource(
    private val quality: VideoQuality = VideoQuality.MEDIUM,
    private val frameRate: Int = 15,
) : CaptureSource {

  override val name = "Ray-Ban Meta"

  private var session: DeviceSession? = null
  private var camera: Camera? = null

  override fun frames(): Flow<Frame> =
      callbackFlow {
            val created = Wearables.createSession(AutoDeviceSelector())
            created.onFailure { error, _ -> close(IllegalStateException("DAT session: ${error.description}")) }
            created.onSuccess { s ->
              session = s
              launch { s.errors.collect { Log.w(TAG, "Session error: ${it.description}") } }
              s.start()
              launch {
                // The camera can only be added once the session is STARTED (otherwise: SESSION_IDLE).
                s.state.first { it == DeviceSessionState.STARTED }
                s.addCamera(StreamConfiguration(videoQuality = quality, frameRate = frameRate, compressVideo = false))
                    .onSuccess { cam ->
                      camera = cam
                      launch {
                        cam.stream.videoStream.collect { vf ->
                          val bmp = i420ToBitmap(vf) ?: return@collect
                          if (trySend(Frame(bmp, SystemClock.elapsedRealtime(), name)).isFailure) bmp.recycle()
                        }
                      }
                      cam.stream.start().onFailure { e, _ -> close(IllegalStateException("Stream: ${e.description}")) }
                    }
                    .onFailure { e, _ -> close(IllegalStateException("Glasses camera: ${e.description}")) }
              }
            }
            awaitClose { stopNow() }
          }
          .buffer(1, BufferOverflow.DROP_OLDEST)

  override suspend fun stop() = stopNow()

  private fun stopNow() {
    camera?.close() // also stops the child stream
    camera = null
    session?.stop()
    session = null
  }

  companion object {
    private const val TAG = "GlassesCameraSource"

    /** I420 (full Y, U, V planes) → ARGB conversion. BT.601 limited range. */
    fun i420ToBitmap(vf: VideoFrame): Bitmap? {
      if (vf.isCompressed) return null
      val w = vf.width
      val h = vf.height
      val ySize = w * h
      val cSize = (w / 2) * (h / 2)
      val buf = vf.buffer.duplicate().apply { rewind() }
      if (buf.remaining() < ySize + 2 * cSize) {
        Log.w(TAG, "Unexpected buffer (${buf.remaining()} B for ${w}x$h): format other than I420?")
        return null
      }
      val data = ByteArray(ySize + 2 * cSize).also { buf.get(it) }
      val out = IntArray(ySize)
      for (j in 0 until h) {
        val cRow = (j / 2) * (w / 2)
        for (i in 0 until w) {
          val y = (data[j * w + i].toInt() and 0xff) - 16
          val u = (data[ySize + cRow + i / 2].toInt() and 0xff) - 128
          val v = (data[ySize + cSize + cRow + i / 2].toInt() and 0xff) - 128
          val yy = 1.164f * y
          val r = (yy + 1.596f * v).toInt().coerceIn(0, 255)
          val g = (yy - 0.392f * u - 0.813f * v).toInt().coerceIn(0, 255)
          val b = (yy + 2.017f * u).toInt().coerceIn(0, 255)
          out[j * w + i] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
        }
      }
      return Bitmap.createBitmap(out, w, h, Bitmap.Config.ARGB_8888)
    }
  }
}
