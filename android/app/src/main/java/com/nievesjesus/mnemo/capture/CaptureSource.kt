package com.nievesjesus.mnemo.capture

import android.graphics.Bitmap
import kotlinx.coroutines.flow.Flow

/**
 * Interfaz de captura abstracta (sección 7.3). El pipeline no sabe si los cuadros vienen de las
 * Ray-Ban Meta ([GlassesCameraSource]) o de la cámara del teléfono ([PhoneCameraSource]).
 *
 * Contrato: cada [Frame] es propiedad del consumidor sólo durante su procesamiento; después se
 * recicla (RN-02: ninguna imagen persiste).
 */
interface CaptureSource {
  val name: String

  /** Cuadros en orientación vertical, ARGB_8888. Se detiene al cancelar la colección. */
  fun frames(): Flow<Frame>

  suspend fun stop()
}

class Frame(val bitmap: Bitmap, val timestampMs: Long, val source: String) {
  fun release() {
    if (!bitmap.isRecycled) bitmap.recycle()
  }
}
