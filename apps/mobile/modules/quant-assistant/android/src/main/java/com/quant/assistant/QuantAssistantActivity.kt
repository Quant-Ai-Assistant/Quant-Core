package com.quant.assistant

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/** A translucent window over the current app that renders the JS assistant sheet. */
class QuantAssistantActivity : ReactActivity() {
  override fun getMainComponentName(): String = "quantAssistant"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onDestroy() {
    if (isFinishing) AssistState.finish()
    super.onDestroy()
  }
}
