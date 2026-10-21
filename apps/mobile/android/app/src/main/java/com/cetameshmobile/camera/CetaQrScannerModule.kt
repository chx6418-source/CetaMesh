package com.cetameshmobile.camera

import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.cetameshmobile.identity.NativeCetaQrScannerSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import java.lang.ref.WeakReference

@ReactModule(name = "CetaQrScanner")
class CetaQrScannerModule(context: ReactApplicationContext) : NativeCetaQrScannerSpec(context) {
  companion object {
    private val main = Handler(Looper.getMainLooper())
    private var pending: Promise? = null
    private var activity = WeakReference<CetaQrActivity>(null)
    fun attach(value: CetaQrActivity): Boolean {
      if (pending == null) return false
      activity = WeakReference(value)
      return true
    }
    fun completeFrom(owner: CetaQrActivity, raw: String?, code: String?) {
      if (activity.get() === owner) complete(raw, code)
    }
    fun complete(raw: String?, code: String?) {
      val promise = pending ?: return
      pending = null
      if (code != null) promise.reject(code, "QR scanning is unavailable")
      else if (raw == null || raw.isEmpty() || raw.length > 8192) promise.reject("invalid_protocol", "Invalid QR payload")
      else promise.resolve(raw)
      activity.get()?.finish()
      activity.clear()
    }
  }
  override fun getName() = "CetaQrScanner"
  override fun scan(promise: Promise) {
    main.post {
      if (pending != null) { promise.reject("sync_conflict", "QR scanner is busy"); return@post }
      val host = reactApplicationContext.currentActivity
      if (host == null || host.isFinishing) {promise.reject("unsupported", "QR scanner is unavailable"); return@post}
      pending = promise
      try {
        host.startActivity(Intent(host, CetaQrActivity::class.java))
        main.postDelayed({ if (pending === promise) complete(null, "cancelled") }, 60000)
      } catch (_: Exception) { complete(null, "provider_error") }
    }
  }
  override fun cancel() {main.post {complete(null, "cancelled")}}
  override fun invalidate() {cancel(); super.invalidate()}
}
