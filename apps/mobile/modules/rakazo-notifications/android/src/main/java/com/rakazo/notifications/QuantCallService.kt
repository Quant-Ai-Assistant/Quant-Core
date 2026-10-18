package com.rakazo.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

private data class RingingCall(
  val botId: String,
  val botName: String,
  val botColor: String,
  val callId: String,
  val expiresAt: Long,
)

/**
 * Keeps a quiet connection to the user's Quant server so a bot's call rings like a phone call
 * with the app closed or the screen off. Interim: without a push relay this is the only way to
 * wake a sleeping Android phone, at the cost of an always-on service notification.
 */
class QuantCallService : Service() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private lateinit var manager: NotificationManager
  private var pollJob: Job? = null
  /** Calls ringing on this phone now, by call id. */
  private val ringing = mutableMapOf<String, RingingCall>()

  override fun onCreate() {
    super.onCreate()
    manager = getSystemService(NotificationManager::class.java)
    createChannels()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val ready = builder(CHANNEL_SERVICE)
      .setSmallIcon(R.drawable.ic_rakazo_notification)
      .setContentTitle(getString(R.string.quant_calls_ready))
      .setContentIntent(openApp())
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(SERVICE_NOTIFICATION_ID, ready, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(SERVICE_NOTIFICATION_ID, ready)
    }
    if (pollJob?.isActive != true) pollJob = scope.launch { poll() }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    scope.cancel()
    synchronized(ringing) {
      for (callId in ringing.keys) manager.cancel(callNotificationId(callId))
      ringing.clear()
    }
    super.onDestroy()
  }

  private suspend fun poll() {
    var backoff = POLL_INTERVAL_MS
    while (scope.isActive) {
      val storage = NotificationStorage(this)
      if (
        !storage.callsEnabled ||
        storage.endpoint.isBlank() ||
        storage.token.isBlank() ||
        !isAllowedNotificationEndpoint(storage.endpoint)
      ) {
        stopSelf()
        return
      }
      try {
        val calls = ringingCalls(storage)
        update(calls)
        backoff = POLL_INTERVAL_MS
      } catch (error: ApiException) {
        // Signed out, or calls are off on this server: nothing will ring until the app says so.
        if (error.status == 401 || error.status == 404) {
          storage.callsEnabled = false
          stopSelf()
          return
        }
        backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
      } catch (_: IOException) {
        backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
      } catch (_: RuntimeException) {
        backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
      }
      delay(backoff)
    }
  }

  private fun ringingCalls(storage: NotificationStorage): List<RingingCall> {
    val body = rpcBody(
      storage.endpoint,
      storage.token,
      storage.spaceId,
      "threads/ringingCalls",
      JSONObject(),
      storage.gateAuth,
    )
    val rows = JSONObject(body).optJSONArray("json") ?: throw IOException("Invalid server response")
    return List(rows.length()) { index ->
      val row = rows.optJSONObject(index) ?: throw IOException("Invalid server response")
      RingingCall(
        botId = row.optString("botId"),
        botName = row.optString("botName"),
        botColor = row.optString("botColor"),
        callId = row.optString("callId"),
        expiresAt = parseInstant(row.optString("expiresAt"))
          ?: (System.currentTimeMillis() + DEFAULT_RING_MS),
      )
    }.filter { it.botId.isNotBlank() && it.callId.isNotBlank() }
  }

  private fun update(calls: List<RingingCall>) = synchronized(ringing) {
    val current = calls.associateBy { it.callId }
    // Answered on another device, declined, or no longer ringing: this phone goes quiet.
    for (callId in ringing.keys - current.keys) manager.cancel(callNotificationId(callId))
    for ((callId, call) in current) if (callId !in ringing) ring(call)
    ringing.clear()
    ringing.putAll(current)
  }

  private fun ring(call: RingingCall) {
    val storage = NotificationStorage(this)
    val screen = incomingScreen(call, storage.spaceId, answer = false)
    val answer = incomingScreen(call, storage.spaceId, answer = true)
    val decline = PendingIntent.getBroadcast(
      this,
      callNotificationId(call.callId),
      Intent(this, QuantCallActionReceiver::class.java)
        .setAction(ACTION_DECLINE)
        .putExtra(EXTRA_BOT_ID, call.botId)
        .putExtra(EXTRA_CALL_ID, call.callId),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = builder(CHANNEL_INCOMING)
      .setSmallIcon(R.drawable.ic_rakazo_notification)
      .setContentTitle(call.botName)
      .setContentText(getString(R.string.quant_calls_incoming))
      .setCategory(Notification.CATEGORY_CALL)
      .setContentIntent(screen)
      .setFullScreenIntent(screen, true)
      .setOngoing(true)
      .setAutoCancel(false)
    if (Build.VERSION.SDK_INT >= 26) {
      builder.setTimeoutAfter((call.expiresAt - System.currentTimeMillis()).coerceAtLeast(1_000L))
    }
    if (Build.VERSION.SDK_INT >= 31) {
      val caller = Person.Builder().setName(call.botName).setImportant(true).build()
      builder.setStyle(Notification.CallStyle.forIncomingCall(caller, decline, answer))
    } else {
      val icon = Icon.createWithResource(this, R.drawable.ic_rakazo_notification)
      @Suppress("DEPRECATION")
      builder.setPriority(Notification.PRIORITY_MAX)
        .addAction(Notification.Action.Builder(icon, getString(R.string.quant_calls_decline), decline).build())
        .addAction(Notification.Action.Builder(icon, getString(R.string.quant_calls_answer), answer).build())
    }
    val notification = builder.build()
    // Keep ringing until the call is answered, declined, or stops.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    manager.notify(callNotificationId(call.callId), notification)
  }

  /** The app's incoming call screen; `answer` picks up as soon as it opens. */
  private fun incomingScreen(call: RingingCall, spaceId: String, answer: Boolean): PendingIntent {
    val link = "rakazo://incoming-call?botId=${Uri.encode(call.botId)}" +
      "&name=${Uri.encode(call.botName)}&color=${Uri.encode(call.botColor)}" +
      "&callId=${Uri.encode(call.callId)}" +
      "&spaceId=${Uri.encode(spaceId)}" + if (answer) "&answer=1" else ""
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
      .setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      this,
      callNotificationId(call.callId) + if (answer) 1 else 0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun openApp(): PendingIntent {
    val intent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(Intent.ACTION_VIEW, Uri.parse("rakazo://")).setPackage(packageName)
    return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)
  }

  private fun builder(channel: String): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channel) else Notification.Builder(this)

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < 26) return
    val incoming = NotificationChannel(
      CHANNEL_INCOMING,
      getString(R.string.quant_calls_channel_incoming),
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 800, 600, 800)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    val service = NotificationChannel(
      CHANNEL_SERVICE,
      getString(R.string.quant_calls_channel_service),
      NotificationManager.IMPORTANCE_MIN,
    ).apply { setShowBadge(false) }
    manager.createNotificationChannels(listOf(incoming, service))
  }

  companion object {
    private const val CHANNEL_INCOMING = "quant_incoming_calls"
    private const val CHANNEL_SERVICE = "quant_calls_service"
    private const val SERVICE_NOTIFICATION_ID = 1201
    private const val POLL_INTERVAL_MS = 3_000L
    private const val MAX_BACKOFF_MS = 30_000L
    private const val DEFAULT_RING_MS = 45_000L
    internal const val ACTION_DECLINE = "com.rakazo.notifications.DECLINE_CALL"
    internal const val EXTRA_BOT_ID = "botId"
    internal const val EXTRA_CALL_ID = "callId"

    internal fun callNotificationId(callId: String) = 0x5100000 + (callId.hashCode() and 0xFFFFF) * 2

    fun start(context: Context) {
      val intent = Intent(context, QuantCallService::class.java)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, QuantCallService::class.java))
    }

    /** The app answered or declined: stop ringing now instead of at the next poll. */
    fun dismiss(context: Context, callId: String) {
      context.getSystemService(NotificationManager::class.java).cancel(callNotificationId(callId))
    }
  }
}

/** The server's ISO timestamps, e.g. 2026-10-15T12:00:30.000Z, without API 26's java.time. */
private fun parseInstant(value: String): Long? =
  listOf("yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX").firstNotNullOfOrNull { pattern ->
    runCatching {
      SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        .parse(value)?.time
    }.getOrNull()
  }

/** Declines from the ringing notification without opening the app. */
class QuantCallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != QuantCallService.ACTION_DECLINE) return
    val botId = intent.getStringExtra(QuantCallService.EXTRA_BOT_ID) ?: return
    val callId = intent.getStringExtra(QuantCallService.EXTRA_CALL_ID) ?: return
    QuantCallService.dismiss(context, callId)
    val pending = goAsync()
    Thread {
      try {
        val storage = NotificationStorage(context)
        runCatching {
          rpc(
            storage.endpoint,
            storage.token,
            storage.spaceId,
            "threads/declineCall",
            JSONObject().put("botId", botId).put("callId", callId).put("outcome", "declined"),
            storage.gateAuth,
          )
        }
      } finally {
        pending.finish()
      }
    }.start()
  }
}

/** Brings the call service back after a reboot or an app update. */
class QuantCallBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (
      intent.action != Intent.ACTION_BOOT_COMPLETED &&
      intent.action != Intent.ACTION_MY_PACKAGE_REPLACED
    ) {
      return
    }
    val storage = NotificationStorage(context)
    if (storage.callsEnabled && storage.token.isNotBlank()) QuantCallService.start(context)
  }
}
