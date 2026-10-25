package com.cetameshmobile.notification

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.TextView

class CetaNotificationPermissionActivity : Activity() {
  private var finished = false

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (!CetaNotificationSendModule.attach(this)) {
      finish()
      return
    }
    setContentView(TextView(this).apply { text = "正在请求 CetaMesh 通知权限" })
    if (Build.VERSION.SDK_INT >= 33 &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), CetaNotificationSendModule.PERMISSION_REQUEST)
    } else {
      complete(true)
    }
  }

  override fun onRequestPermissionsResult(
      requestCode: Int,
      permissions: Array<out String>,
      grants: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grants)
    if (requestCode == CetaNotificationSendModule.PERMISSION_REQUEST) {
      complete(grants.firstOrNull() == PackageManager.PERMISSION_GRANTED)
    }
  }

  @Deprecated("Back means the system notification permission was not granted")
  override fun onBackPressed() {
    complete(false)
  }

  private fun complete(granted: Boolean) {
    if (finished) return
    finished = true
    CetaNotificationSendModule.completePermission(this, granted)
  }
}
