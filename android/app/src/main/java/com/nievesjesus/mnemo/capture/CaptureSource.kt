package com.nievesjesus.mnemo.capture

import android.graphics.Bitmap
import kotlinx.coroutines.flow.Flow

/**
 * Abstract capture interface. The pipeline does not know whether the frames come from the
 * Ray-Ban Meta glasses ([GlassesCameraSource]) or from the phone camera ([PhoneCameraSource]).
 *
 * Contract: each [Frame] belongs to the consumer only while it is being processed; afterwards it
 * is recycled (no image ever persists).
 */
interface CaptureSource {
  val name: String

  /** Frames in portrait orientation, ARGB_8888. Stops when the collection is cancelled. */
  fun frames(): Flow<Frame>

  suspend fun stop()
}

class Frame(val bitmap: Bitmap, val timestampMs: Long, val source: String) {
  fun release() {
    if (!bitmap.isRecycled) bitmap.recycle()
  }
}
