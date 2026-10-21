package com.cetameshmobile.camera

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory

class CetaQrActivity : Activity() {
  private lateinit var camera: DecoratedBarcodeView
  private var requesting = false
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (!CetaQrScannerModule.attach(this)) {finish();return}
    val layout = LinearLayout(this).apply {orientation = LinearLayout.VERTICAL}
    camera = DecoratedBarcodeView(this)
    camera.barcodeView.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
    camera.setStatusText("扫描 CetaMesh 配对二维码")
    layout.addView(camera, LinearLayout.LayoutParams(-1, 0, 1f))
    layout.addView(Button(this).apply {text="取消";setOnClickListener {CetaQrScannerModule.completeFrom(this@CetaQrActivity,null,"cancelled")}})
    setContentView(layout)
    camera.decodeSingle(object : BarcodeCallback {
      override fun barcodeResult(result: BarcodeResult) {CetaQrScannerModule.completeFrom(this@CetaQrActivity,result.text,null)}
    })
    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      requesting = true
      requestPermissions(arrayOf(Manifest.permission.CAMERA), 31)
    }
  }
  override fun onResume() {
    super.onResume()
    if (::camera.isInitialized && !requesting && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera.resume()
  }
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grants: IntArray) {
    super.onRequestPermissionsResult(requestCode,permissions,grants)
    if (requestCode == 31) {
      requesting=false
      if (grants.firstOrNull() == PackageManager.PERMISSION_GRANTED) camera.resume()
      else CetaQrScannerModule.completeFrom(this@CetaQrActivity,null,"permission_denied")
    }
  }
  override fun onPause() {
    if (::camera.isInitialized) camera.pause()
    if (!requesting && !isFinishing) CetaQrScannerModule.completeFrom(this@CetaQrActivity,null,"cancelled")
    super.onPause()
  }
  override fun onDestroy() {CetaQrScannerModule.completeFrom(this@CetaQrActivity,null,"cancelled");super.onDestroy()}
}
