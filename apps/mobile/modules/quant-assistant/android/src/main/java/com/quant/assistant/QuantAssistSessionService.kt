package com.quant.assistant

import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import java.io.File
import java.io.FileOutputStream

class QuantAssistSessionService : VoiceInteractionSessionService() {
  override fun onNewSession(args: Bundle?): VoiceInteractionSession = QuantAssistSession(this)
}

/**
 * One press of the power button: opens the assistant sheet over the current app and keeps the
 * screenshot Android hands the assistant, so "About the screen" can attach what was open.
 */
class QuantAssistSession(service: VoiceInteractionSessionService) : VoiceInteractionSession(service) {
  override fun onCreate() {
    super.onCreate()
    // The sheet is an activity; the session's own window would only cover it.
    if (Build.VERSION.SDK_INT >= 26) setUiEnabled(false)
  }

  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args, showFlags)
    AssistState.begin(this)
    startAssistantActivity(
      Intent(context, QuantAssistantActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
    )
  }

  override fun onHandleScreenshot(screenshot: Bitmap?) {
    if (screenshot == null) {
      AssistState.screenshotReady(null)
      return
    }
    val dir = File(context.cacheDir, "assist").apply { mkdirs() }
    dir.listFiles()?.forEach { it.delete() }
    val file = File(dir, "screen-${System.currentTimeMillis()}.jpg")
    val saved = runCatching {
      FileOutputStream(file).use { screenshot.compress(Bitmap.CompressFormat.JPEG, 85, it) }
    }.isSuccess
    AssistState.screenshotReady(if (saved) file.absolutePath else null)
  }

  override fun onHide() {
    super.onHide()
    AssistState.end(this)
  }
}
