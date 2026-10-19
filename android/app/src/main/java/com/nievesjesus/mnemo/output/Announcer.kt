package com.nievesjesus.mnemo.output

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Stage 08 · voice output. The DAT exposes no speaker API: the glasses are an ordinary Bluetooth
 * audio output, so the system's local TTS with USAGE_MEDIA plays through the open-ear speakers
 * when they are connected (same approach as the official BirdSpotter sample).
 * Local TTS, no cloud services.
 */
class Announcer(ctx: Context) : TextToSpeech.OnInitListener {
  private val tts = TextToSpeech(ctx, this)
  private var ready = false

  override fun onInit(status: Int) {
    if (status != TextToSpeech.SUCCESS) return
    tts.language = Locale.forLanguageTag("es-AR")
    tts.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
    tts.setSpeechRate(0.95f)
    // Avoid a voice that needs the network: if the chosen one is not local, look for one that is.
    tts.voices?.firstOrNull { it.locale.language == "es" && !it.isNetworkConnectionRequired }?.let { tts.voice = it }
    ready = true
  }

  fun say(text: String) {
    if (ready) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "mnemo")
  }

  fun speaking() = ready && tts.isSpeaking

  fun shutdown() = tts.shutdown()
}
