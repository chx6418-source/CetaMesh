package com.cetameshmobile.notification

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.cetameshmobile.identity.NativeCetaNotificationSendSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

@ReactModule(name = CetaNotificationSendModule.NAME)
class CetaNotificationSendModule(context: ReactApplicationContext) :
    NativeCetaNotificationSendSpec(context) {
  companion object {
    const val NAME = "CetaNotificationSend"
    const val PERMISSION_REQUEST = 71
    private const val CHANNEL_ID = "cetamesh-events"
    private const val MAX_BYTES = 4096
    private const val MAX_TITLE = 120
    private const val MAX_BODY = 500
    private val main = Handler(Looper.getMainLooper())
    private val notificationId = AtomicInteger(1000)
    private var pending: Pending? = null
    private var permissionActivity = WeakReference<CetaNotificationPermissionActivity>(null)

    private data class Pending(val payload: String, val promise: Promise)

    fun attach(value: CetaNotificationPermissionActivity): Boolean {
      if (pending == null) return false
      permissionActivity = WeakReference(value)
      return true
    }

    fun completePermission(owner: CetaNotificationPermissionActivity, granted: Boolean) {
      if (permissionActivity.get() !== owner) return
      if (granted) deliver(owner) else complete("permission_denied")
    }

    fun cancelFrom(owner: CetaNotificationPermissionActivity) {
      if (permissionActivity.get() === owner) complete("cancelled")
    }

    private fun errorMessage(code: String) = when (code) {
      "invalid_protocol" -> "Invalid notification payload"
      "permission_denied" -> "Notification permission was denied"
      "unsupported" -> "Notifications are unavailable"
      "provider_error" -> "Notification delivery failed"
      "timeout" -> "Notification request timed out"
      else -> "Notification delivery was cancelled"
    }

    private fun complete(code: String?) {
      val current = pending ?: return
      pending = null
      permissionActivity.get()?.finish()
      permissionActivity.clear()
      if (code == null) current.promise.resolve(null)
      else current.promise.reject(code, errorMessage(code))
    }

    private fun validText(value: String, max: Int, allowEmpty: Boolean): Boolean {
      if (value.length > max || (!allowEmpty && value.trim().isEmpty())) return false
      return value.all { character ->
        character.code >= 32 || character == '\t' || character == '\n' || character == '\r'
      }
    }

    private fun parsePayload(raw: String): JSONObject? {
      if (raw.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return null
      return try {
        val value = JSONObject(raw)
        val keys = value.keys()
        while (keys.hasNext()) {
          if (keys.next() !in setOf("title", "body")) return null
        }
        val title = value.optString("title", "")
        val body = if (value.has("body") && !value.isNull("body")) {
          value.optString("body", "\u0000")
        } else {
          ""
        }
        if (!validText(title, MAX_TITLE, false) || !validText(body, MAX_BODY, true)) null
        else value
      } catch (_: Exception) {
        null
      }
    }

    private fun notificationsEnabled(context: Context): Boolean {
      if (Build.VERSION.SDK_INT >= 33 &&
          ContextCompat.checkSelfPermission(
              context,
              Manifest.permission.POST_NOTIFICATIONS,
          ) != PackageManager.PERMISSION_GRANTED) {
        return false
      }
      return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    private fun deliver(context: Context) {
      val current = pending ?: return
      val payload = parsePayload(current.payload)
      if (payload == null) {
        complete("invalid_protocol")
        return
      }
      if (!notificationsEnabled(context)) {
        complete("permission_denied")
        return
      }
      try {
        val application = context.applicationContext
        if (Build.VERSION.SDK_INT >= 26) {
          val manager = application.getSystemService(NotificationManager::class.java)
          manager.createNotificationChannel(
              NotificationChannel(
                  CHANNEL_ID,
                  "CetaMesh notifications",
                  NotificationManager.IMPORTANCE_DEFAULT,
              ),
          )
        }
        val body = payload.optString("body", "")
        val notification = NotificationCompat.Builder(application, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(payload.optString("title"))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(application).notify(notificationId.incrementAndGet(), notification)
        complete(null)
      } catch (_: SecurityException) {
        complete("permission_denied")
      } catch (_: Exception) {
        complete("provider_error")
      }
    }
  }

  override fun getName() = NAME

  override fun send(payload: String, promise: Promise) {
    main.post {
      if (pending != null) {
        promise.reject("sync_conflict", "Another notification is pending")
        return@post
      }
      if (parsePayload(payload) == null) {
        promise.reject("invalid_protocol", "Invalid notification payload")
        return@post
      }
      val host = reactApplicationContext.currentActivity
      if (host == null || host.isFinishing) {
        promise.reject("unsupported", "Notifications are unavailable")
        return@post
      }
      pending = Pending(payload, promise)
      if (Build.VERSION.SDK_INT >= 33 &&
          ContextCompat.checkSelfPermission(
              host,
              Manifest.permission.POST_NOTIFICATIONS,
          ) != PackageManager.PERMISSION_GRANTED) {
        try {
          host.startActivity(Intent(host, CetaNotificationPermissionActivity::class.java))
        } catch (_: Exception) {
          complete("provider_error")
        }
      } else {
        deliver(host)
      }
      main.postDelayed({
        if (pending?.promise === promise) complete("timeout")
      }, 30_000)
    }
  }

  override fun cancel() {
    main.post { complete("cancelled") }
  }

  override fun invalidate() {
    cancel()
    super.invalidate()
  }
}
