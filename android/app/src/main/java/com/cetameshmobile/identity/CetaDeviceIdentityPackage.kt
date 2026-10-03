package com.cetameshmobile.identity

import com.cetameshmobile.pairing.CetaPairingTransportModule
import com.cetameshmobile.camera.CetaQrScannerModule
import com.cetameshmobile.camera.CetaCameraCaptureModule
import com.cetameshmobile.microphone.CetaMicrophoneRecordModule
import com.cetameshmobile.notification.CetaNotificationSendModule
import com.cetameshmobile.appinfo.CetaAppInfoModule
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class CetaDeviceIdentityPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      when(name) {
        CetaDeviceIdentityModule.NAME -> CetaDeviceIdentityModule(reactContext)
        "CetaPairingTransport" -> CetaPairingTransportModule(reactContext)
        "CetaQrScanner" -> CetaQrScannerModule(reactContext)
        CetaCameraCaptureModule.NAME -> CetaCameraCaptureModule(reactContext)
        CetaMicrophoneRecordModule.NAME -> CetaMicrophoneRecordModule(reactContext)
        CetaNotificationSendModule.NAME -> CetaNotificationSendModule(reactContext)
        CetaAppInfoModule.NAME -> CetaAppInfoModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf("CetaPairingTransport" to ReactModuleInfo("CetaPairingTransport", CetaPairingTransportModule::class.java.name, false, false, false, true),
        "CetaQrScanner" to ReactModuleInfo("CetaQrScanner", CetaQrScannerModule::class.java.name, false, false, false, true),
        CetaCameraCaptureModule.NAME to ReactModuleInfo(CetaCameraCaptureModule.NAME, CetaCameraCaptureModule::class.java.name, false, false, false, true),
        CetaMicrophoneRecordModule.NAME to ReactModuleInfo(CetaMicrophoneRecordModule.NAME, CetaMicrophoneRecordModule::class.java.name, false, false, false, true),
        CetaNotificationSendModule.NAME to ReactModuleInfo(CetaNotificationSendModule.NAME, CetaNotificationSendModule::class.java.name, false, false, false, true),
        CetaAppInfoModule.NAME to ReactModuleInfo(CetaAppInfoModule.NAME, CetaAppInfoModule::class.java.name, false, false, false, false),
        CetaDeviceIdentityModule.NAME to ReactModuleInfo(
        CetaDeviceIdentityModule.NAME,
        CetaDeviceIdentityModule::class.java.name,
        false, false, false, true,
    ))
  }
}
