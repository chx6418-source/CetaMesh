package com.cetameshmobile.appinfo

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = CetaAppInfoModule.NAME)
class CetaAppInfoModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  companion object { const val NAME = "CetaAppInfo" }

  override fun getName(): String = NAME

  override fun getConstants(): Map<String, Any> {
    val version = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    return mapOf("versionName" to version)
  }
}
