package com.quant.assistant

import android.service.voice.VoiceInteractionSession

/** The current assistant request: its session and the screenshot, once Android delivers it. */
object AssistState {
  private var session: VoiceInteractionSession? = null
  private var screenshotPath: String? = null
  private var screenshotSettled = false
  private val waiting = mutableListOf<(String?) -> Unit>()
  private val lock = Any()

  fun begin(next: VoiceInteractionSession) {
    synchronized(lock) {
      session = next
      screenshotPath = null
      screenshotSettled = false
    }
  }

  fun screenshotReady(path: String?) {
    val callbacks = synchronized(lock) {
      screenshotPath = path
      screenshotSettled = true
      waiting.toList().also { waiting.clear() }
    }
    callbacks.forEach { it(path) }
  }

  /** Answers now when the screenshot is in, else when it arrives or the timeout passes. */
  fun awaitScreenshot(timeoutMs: Long, callback: (String?) -> Unit) {
    val ready = synchronized(lock) {
      if (screenshotSettled) true else {
        waiting.add(callback)
        false
      }
    }
    if (ready) {
      callback(synchronized(lock) { screenshotPath })
      return
    }
    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
      val pending = synchronized(lock) { waiting.remove(callback) }
      if (pending) callback(null)
    }, timeoutMs)
  }

  fun end(ended: VoiceInteractionSession) {
    synchronized(lock) { if (session === ended) session = null }
  }

  /** The sheet closed: let the system end the request. */
  fun finish() {
    val current = synchronized(lock) { session.also { session = null } }
    current?.finish()
  }
}
