package com.rakazo.notifications

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RakazoNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RakazoNotifications")

    AsyncFunction("getSettings") {
      NotificationStorage(context()).settings.toMap()
    }

    AsyncFunction("setSettings") { value: Map<String, Boolean>, endpoint: String, token: String, spaceId: String, gateAuth: String ->
      val context = context()
      val storage = NotificationStorage(context)
      if (endpoint.isNotBlank() && !isAllowedNotificationEndpoint(endpoint)) {
        throw IllegalArgumentException("Public servers need https://. HTTP only works on your local network.")
      }
      storage.endpoint = endpoint
      storage.token = token
      storage.spaceId = spaceId
      storage.gateAuth = gateAuth
      storage.settings = NotificationSettings.fromMap(value)
      if (storage.settings.liveConnection && endpoint.isNotBlank() && token.isNotBlank()) {
        RakazoNotificationService.start(context)
      } else {
        RakazoNotificationService.stop(context)
      }
    }

    AsyncFunction("resume") { endpoint: String, token: String, spaceId: String, gateAuth: String ->
      val context = context()
      if (endpoint.isNotBlank() && !isAllowedNotificationEndpoint(endpoint)) {
        RakazoNotificationService.stop(context)
      } else {
        val storage = NotificationStorage(context)
        storage.endpoint = endpoint
        storage.token = token
        storage.spaceId = spaceId
        storage.gateAuth = gateAuth
        if (storage.settings.liveConnection && endpoint.isNotBlank() && token.isNotBlank()) {
          RakazoNotificationService.start(context)
        }
      }
    }

    AsyncFunction("stop") { clearSession: Boolean ->
      val context = context()
      if (clearSession) {
        RakazoNotificationService.clearSession(context)
        QuantCallService.stop(context)
        val storage = NotificationStorage(context)
        storage.token = ""
        storage.spaceId = ""
        storage.gateAuth = ""
        storage.callsEnabled = false
        storage.remindersEnabled = false
      } else {
        RakazoNotificationService.stop(context)
      }
    }

    AsyncFunction("setCalls") { calls: Boolean, reminders: Boolean, endpoint: String, token: String, spaceId: String, gateAuth: String ->
      val context = context()
      if ((calls || reminders) && !isAllowedNotificationEndpoint(endpoint)) {
        throw IllegalArgumentException("Public servers need https://. HTTP only works on your local network.")
      }
      val storage = NotificationStorage(context)
      storage.endpoint = endpoint
      storage.token = token
      storage.spaceId = spaceId
      storage.gateAuth = gateAuth
      storage.callsEnabled = calls && token.isNotBlank()
      storage.remindersEnabled = reminders && token.isNotBlank()
      if (storage.callsEnabled || storage.remindersEnabled) {
        QuantCallService.start(context)
      } else {
        QuantCallService.stop(context)
      }
    }

    AsyncFunction("dismissCall") { callId: String ->
      QuantCallService.dismiss(context(), callId)
    }

    AsyncFunction("dismissReminder") { reminderId: String ->
      QuantCallService.dismissReminder(context(), reminderId)
    }

    AsyncFunction("canUseFullScreenIntent") {
      if (Build.VERSION.SDK_INT < 34) {
        true
      } else {
        context().getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
      }
    }

    AsyncFunction("openFullScreenIntentSettings") {
      val context = context()
      val intent = if (Build.VERSION.SDK_INT >= 34) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    AsyncFunction("isIgnoringBatteryOptimizations") {
      val context = context()
      context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
    }

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      val context = context()
      context.startActivity(
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    /** An incoming call shows over the lock screen and wakes it, like the phone app. */
    AsyncFunction("showOverLockScreen") { show: Boolean ->
      val activity = appContext.currentActivity
      if (activity != null && Build.VERSION.SDK_INT >= 27) {
        activity.runOnUiThread {
          activity.setShowWhenLocked(show)
          activity.setTurnScreenOn(show)
        }
      }
    }

    AsyncFunction("setOpenThread") { botId: String?, threadId: String? ->
      RakazoNotificationService.setOpenThread(context(), botId, threadId)
    }

    AsyncFunction("openSettings") {
      val context = context()
      context.startActivity(
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    AsyncFunction("canPostPromotedNotifications") {
      if (Build.VERSION.SDK_INT < 36) {
        true
      } else {
        val manager = context().getSystemService(NotificationManager::class.java)
        runCatching {
          manager.javaClass.getMethod("canPostPromotedNotifications").invoke(manager) as Boolean
        }.getOrDefault(false)
      }
    }

    AsyncFunction("openPromotedSettings") {
      val context = context()
      val promoted = Intent("android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS")
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { context.startActivity(promoted) }.getOrElse {
        context.startActivity(
          Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
    }
  }

  private fun context() = appContext.reactContext
    ?: throw IllegalStateException("Android application context is unavailable")
}
