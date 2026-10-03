package com.cetameshmobile.microphone

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.cetameshmobile.identity.NativeCetaMicrophoneRecordSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import java.io.File
import java.lang.ref.WeakReference
import org.json.JSONObject

@ReactModule(name = CetaMicrophoneRecordModule.NAME)
class CetaMicrophoneRecordModule(context: ReactApplicationContext) :
    NativeCetaMicrophoneRecordSpec(context) {
  companion object {
    const val NAME = "CetaMicrophoneRecord"
    private const val MAX_BYTES = 8 * 1024 * 1024L
    private val main = Handler(Looper.getMainLooper())
    private var pending: Promise? = null
    private var target: File? = null
    private var activity = WeakReference<CetaMicrophoneRecordActivity>(null)

    fun attach(value: CetaMicrophoneRecordActivity): Boolean {
      if (pending == null) return false
      activity = WeakReference(value)
      return true
    }

    fun outputFile(): File? = target

    fun completeFrom(
        owner: CetaMicrophoneRecordActivity,
        success: Boolean,
        code: String?,
        durationMs: Long,
    ) {
      if (activity.get() === owner) complete(success, code, durationMs)
    }

    private fun message(code: String) = when (code) {
      "permission_denied" -> "Microphone permission was denied"
      "unsupported" -> "Microphone recording is unavailable"
      "timeout" -> "Microphone recording timed out"
      else -> "Microphone recording was cancelled"
    }

    fun complete(success: Boolean, code: String?, durationMs: Long) {
      val promise = pending ?: return
      pending = null
      val file = target
      target = null
      activity.get()?.finish()
      activity.clear()
      if (!success || code != null || file == null || !file.isFile ||
          file.length() <= 0 || file.length() > MAX_BYTES ||
          durationMs <= 0 || durationMs > 60_000) {
        file?.delete()
        promise.reject(code ?: "unsupported", message(code ?: "unsupported"))
        return
      }
      promise.resolve(
          JSONObject()
              .put("uri", Uri.fromFile(file).toString())
              .put("mime", "audio/mp4")
              .put("name", file.name)
              .put("durationMs", durationMs)
              .toString())
    }
  }

  override fun getName() = NAME

  override fun record(promise: Promise) {
    main.post {
      if (pending != null) {
        promise.reject("sync_conflict", "Microphone recording is busy")
        return@post
      }
      val host = reactApplicationContext.currentActivity
      if (host == null || host.isFinishing) {
        promise.reject("unsupported", "Microphone recording is unavailable")
        return@post
      }
      val file = try {
        File.createTempFile("ceta-recording-", ".m4a", reactApplicationContext.cacheDir)
      } catch (_: Exception) {
        promise.reject("storage_error", "Microphone recording is unavailable")
        return@post
      }
      pending = promise
      target = file
      try {
        host.startActivity(Intent(host, CetaMicrophoneRecordActivity::class.java))
        main.postDelayed({
          if (pending === promise) complete(false, "timeout", 0)
        }, 65_000)
      } catch (_: Exception) {
        complete(false, "provider_error", 0)
      }
    }
  }

  override fun cancel() {
    main.post { complete(false, "cancelled", 0) }
  }

  override fun invalidate() {
    cancel()
    super.invalidate()
  }
}
