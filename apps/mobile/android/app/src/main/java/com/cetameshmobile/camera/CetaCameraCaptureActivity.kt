package com.cetameshmobile.camera

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.MediaStore

class CetaCameraCaptureActivity : Activity() {
  companion object {
    private const val CAMERA_REQUEST = 41
    private const val CAPTURE_REQUEST = 42
  }

  private var finished = false

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (!CetaCameraCaptureModule.attach(this)) {
      finish()
      return
    }
    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
    } else {
      launchCamera()
    }
  }

  private fun launchCamera() {
    val uri = try {
      CetaCameraCaptureModule.outputUri(this)
    } catch (_: Exception) {
      complete(false, "storage_error")
      return
    }
    if (uri == null) {
      complete(false, "storage_error")
      return
    }
    val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
      putExtra(MediaStore.EXTRA_OUTPUT, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }
    if (intent.resolveActivity(packageManager) == null) {
      complete(false, "unsupported")
      return
    }
    try {
      startActivityForResult(intent, CAPTURE_REQUEST)
    } catch (_: Exception) {
      complete(false, "provider_error")
    }
  }

  override fun onRequestPermissionsResult(
      requestCode: Int,
      permissions: Array<out String>,
      grants: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grants)
    if (requestCode == CAMERA_REQUEST) {
      if (grants.firstOrNull() == PackageManager.PERMISSION_GRANTED) launchCamera()
      else complete(false, "permission_denied")
    }
  }

  @Deprecated("Activity result API is sufficient for the isolated M4 provider")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == CAPTURE_REQUEST) {
      complete(resultCode == RESULT_OK, if (resultCode == RESULT_OK) null else "cancelled")
    }
  }

  private fun complete(success: Boolean, code: String?) {
    if (finished) return
    finished = true
    CetaCameraCaptureModule.completeFrom(this, success, code)
  }

  override fun onDestroy() {
    if (!finished) complete(false, "cancelled")
    super.onDestroy()
  }
}
