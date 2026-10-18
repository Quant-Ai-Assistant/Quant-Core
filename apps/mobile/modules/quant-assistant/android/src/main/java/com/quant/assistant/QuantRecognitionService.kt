package com.quant.assistant

import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/**
 * Android only lists an assistant that names a speech recognizer. Quant transcribes voice on
 * its server, so this one declines and other apps keep their own recognizer.
 */
class QuantRecognitionService : RecognitionService() {
  override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
    listener?.error(SpeechRecognizer.ERROR_CLIENT)
  }

  override fun onCancel(listener: Callback?) = Unit

  override fun onStopListening(listener: Callback?) = Unit
}
