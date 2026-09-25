package com.nievesjesus.mnemo.output

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Escucha «¿quién es?» (CU-04) con el reconocedor ON-DEVICE de Android (API 31+): el audio no sale
 * del teléfono (RN-05). Si el dispositivo no lo tiene, no se cae al reconocedor en la nube: se avisa
 * y queda el botón. Alternativa con el micrófono de las gafas: `mwdat-speech` (experimental en el DAT 1.0).
 */
class VoiceListener(
    private val ctx: Context,
    private val onAsk: (String) -> Unit,
    private val onStatus: (String) -> Unit,
    private val muted: () -> Boolean = { false },
) : RecognitionListener {
  private val main = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var active = false

  fun start(): Boolean {
    if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx)) {
      onStatus("Este teléfono no tiene reconocimiento de voz en el dispositivo")
      return false
    }
    active = true
    main.post {
      recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx).also { it.setRecognitionListener(this) }
      listen()
    }
    return true
  }

  fun stop() {
    active = false
    main.post {
      recognizer?.destroy()
      recognizer = null
    }
    onStatus("Micrófono apagado")
  }

  private fun listen() {
    if (!active) return
    if (muted()) { main.postDelayed(::listen, 300); return } // no escucharse a sí mismo mientras habla el TTS
    recognizer?.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-AR")
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    })
    onStatus("Escuchando «¿quién es?»")
  }

  private fun handle(texts: List<String>?) {
    texts?.firstOrNull { isAsk(it) }?.let { onAsk(it) }
  }

  override fun onResults(results: Bundle) {
    val texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
    texts?.firstOrNull()?.let { onStatus("«$it»") }
    handle(texts)
    main.postDelayed(::listen, 150) // escucha continua
  }

  override fun onError(error: Int) {
    // Silencio / nada reconocido son normales en escucha continua: se reinicia.
    main.postDelayed(::listen, if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) 800 else 250)
  }

  override fun onPartialResults(partial: Bundle) = Unit
  override fun onReadyForSpeech(params: Bundle?) = Unit
  override fun onBeginningOfSpeech() = Unit
  override fun onRmsChanged(rmsdB: Float) = Unit
  override fun onBufferReceived(buffer: ByteArray?) = Unit
  override fun onEndOfSpeech() = Unit
  override fun onEvent(eventType: Int, params: Bundle?) = Unit

  companion object {
    private val ASK = Regex("(?<!\\p{L})(qui[eé]n\\s+(es|est[aá]|era|ser[aá]|me\\s+habla|viene)|c[oó]mo\\s+se\\s+llama)(?!\\p{L})", RegexOption.IGNORE_CASE)
    private val ASK_SHORT = Regex("^[\\s¿¡]*(qu[eé]|qui[eé]n)(\\s+es)?[\\s?!.]*$", RegexOption.IGNORE_CASE)

    /** Mismas frases que web/src/voice/listener.ts y core/mnemo/voice.py. */
    fun isAsk(text: String) = ASK.containsMatchIn(text) || ASK_SHORT.matches(text)
  }
}
