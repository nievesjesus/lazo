package com.nievesjesus.mnemo.capture

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.SystemClock
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import android.util.Size
import java.util.concurrent.Executors
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.channels.BufferOverflow

/**
 * Cámara del teléfono con CameraX. La trasera, con el teléfono montado a la altura de los ojos,
 * es el sustituto de las gafas con el que se obtienen las métricas de la sección 7.6.
 */
class PhoneCameraSource(
    private val context: Context,
    private val owner: LifecycleOwner,
    private val lensFacing: Int = CameraSelector.LENS_FACING_BACK,
) : CaptureSource {

  override val name =
      if (lensFacing == CameraSelector.LENS_FACING_BACK) "cámara trasera (altura de los ojos)" else "cámara frontal"

  private var provider: ProcessCameraProvider? = null
  private val executor = Executors.newSingleThreadExecutor()

  override fun frames(): Flow<Frame> =
      callbackFlow {
            val provider = ProcessCameraProvider.getInstance(context).get()
            this@PhoneCameraSource.provider = provider
            val analysis =
                ImageAnalysis.Builder()
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER))
                            .build())
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .build()
            analysis.setAnalyzer(executor) { image ->
              val raw = image.toBitmap()
              val rotation = image.imageInfo.rotationDegrees
              image.close()
              val upright =
                  if (rotation == 0) raw
                  else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
                      .also { raw.recycle() }
              val sent = trySend(Frame(upright, SystemClock.elapsedRealtime(), name))
              if (sent.isFailure) upright.recycle()
            }
            ContextCompat.getMainExecutor(context).execute {
              provider.unbindAll()
              provider.bindToLifecycle(owner, CameraSelector.Builder().requireLensFacing(lensFacing).build(), analysis)
            }
            awaitClose { ContextCompat.getMainExecutor(context).execute { provider.unbindAll() } }
          }
          .buffer(1, BufferOverflow.DROP_OLDEST)

  override suspend fun stop() {
    ContextCompat.getMainExecutor(context).execute { provider?.unbindAll() }
  }
}
