package com.quant.assistant

import android.app.role.RoleManager
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class QuantAssistantModule : Module() {
  private fun context() = requireNotNull(appContext.reactContext) { "React context is unavailable" }

  override fun definition() = ModuleDefinition {
    Name("QuantAssistant")

    /** Whether Quant is the phone's digital assistant; false where Android cannot say. */
    AsyncFunction("isDefaultAssistant") {
      if (Build.VERSION.SDK_INT < 29) {
        false
      } else {
        val roles = context().getSystemService(RoleManager::class.java)
        roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT) && roles.isRoleHeld(RoleManager.ROLE_ASSISTANT)
      }
    }

    /** Android lets no app request the assistant role, so this opens where the user picks it. */
    AsyncFunction("openAssistantSettings") {
      val context = context()
      val voice = Intent(Settings.ACTION_VOICE_INPUT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { context.startActivity(voice) }.getOrElse {
        context.startActivity(
          Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
    }

    /** The file of the screen that was open when the assistant was called, or null. */
    AsyncFunction("screenshot") { promise: Promise ->
      AssistState.awaitScreenshot(1_500) { path -> promise.resolve(path) }
    }

    /** Closes the sheet and ends the assistant request. */
    AsyncFunction("close") {
      appContext.currentActivity?.let { activity ->
        if (activity is QuantAssistantActivity) activity.finish()
      }
      AssistState.finish()
    }
  }
}
