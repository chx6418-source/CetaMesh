package com.cetameshmobile.camera

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.core.content.FileProvider
import com.cetameshmobile.identity.NativeCetaCameraCaptureSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import java.io.File
import java.lang.ref.WeakReference
import org.json.JSONObject

@ReactModule(name = CetaCameraCaptureModule.NAME)
class CetaCameraCaptureModule(context: ReactApplicationContext) :
    NativeCetaCameraCaptureSpec(context) {
  companion object {
    const val NAME = "CetaCameraCapture"
    private const val AUTHORITY_SUFFIX = ".fileprovider"
    private const val MAX_BYTES = 4 * 1024 * 1024L
    private val main = Handler(Looper.getMainLooper())
    private var pending: Promise? = null
    private var target: File? = null
    private var activity = WeakReference<CetaCameraCaptureActivity>(null)

    fun attach(value: CetaCameraCaptureActivity): Boolean {
      if (pending == null) return false
      activity = WeakReference(value)
      return true
    }

    fun outputUri(context: Context): Uri? =
        target?.let { FileProvider.getUriForFile(context, context.packageName + AUTHORITY_SUFFIX, it) }

    fun completeFrom(owner: CetaCameraCaptureActivity, success: Boolean, code: String?) {
      if (activity.get() === owner) complete(success, code)
    }

    private fun message(code: String) = when (code) {
      "permission_denied" -> "Camera permission was denied"
      "unsupported" -> "Camera capture is unavailable"
      "timeout" -> "Camera capture timed out"
      else -> "Camera capture was cancelled"
    }

    fun complete(success: Boolean, code: String?) {
      val promise = pending ?: return
      pending = null
      val file = target
      target = null
      activity.get()?.finish()
      activity.clear()
      if (!success || code != null || file == null || !file.isFile ||
          file.length() <= 0 || file.length() > MAX_BYTES) {
        file?.delete()
        promise.reject(code ?: "unsupported", message(code ?: "unsupported"))
        return
      }
      val payload = JSONObject()
          .put("uri", Uri.fromFile(file).toString())
          .put("mime", "image/jpeg")
          .put("name", file.name)
          .toString()
      promise.resolve(payload)
    }
  }

  override fun getName() = NAME

  override fun capture(promise: Promise) {
    main.post {
      if (pending != null) {
        promise.reject("sync_conflict", "Camera capture is busy")
        return@post
      }
      val host = reactApplicationContext.currentActivity
      if (host == null || host.isFinishing) {
        promise.reject("unsupported", "Camera capture is unavailable")
        return@post
      }
      val file = try {
        File.createTempFile("ceta-camera-", ".jpg", reactApplicationContext.cacheDir)
      } catch (_: Exception) {
        promise.reject("storage_error", "Camera capture is unavailable")
        return@post
      }
      pending = promise
      target = file
      try {
        host.startActivity(Intent(host, CetaCameraCaptureActivity::class.java))
        main.postDelayed({
          if (pending === promise) complete(false, "timeout")
        }, 60_000)
      } catch (_: Exception) {
        complete(false, "provider_error")
      }
    }
  }

  override fun cancel() {
    main.post { complete(false, "cancelled") }
  }

  override fun invalidate() {
    cancel()
    super.invalidate()
  }
}
