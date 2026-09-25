package com.nievesjesus.mnemo.output

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Etapa 08 · salida por voz. El DAT no expone una API de altavoz: las gafas son una salida de audio
 * Bluetooth común, así que el TTS local del sistema con USAGE_MEDIA suena por los altavoces de oído
 * abierto cuando están conectadas (mismo enfoque que el sample oficial BirdSpotter).
 * TTS local, sin servicios en la nube (tabla 7).
 */
class Announcer(ctx: Context) : TextToSpeech.OnInitListener {
  private val tts = TextToSpeech(ctx, this)
  private var ready = false

  override fun onInit(status: Int) {
    if (status != TextToSpeech.SUCCESS) return
    tts.language = Locale.forLanguageTag("es-AR")
    tts.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
    tts.setSpeechRate(0.95f)
    // Se evita una voz que requiera red: si la elegida no es local, se busca una que sí lo sea.
    tts.voices?.firstOrNull { it.locale.language == "es" && !it.isNetworkConnectionRequired }?.let { tts.voice = it }
    ready = true
  }

  fun say(text: String) {
    if (ready) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "mnemo")
  }

  fun shutdown() = tts.shutdown()
}
