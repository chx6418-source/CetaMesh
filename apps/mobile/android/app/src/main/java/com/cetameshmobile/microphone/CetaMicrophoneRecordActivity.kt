package com.cetameshmobile.microphone

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class CetaMicrophoneRecordActivity : Activity() {
  companion object {
    private const val MICROPHONE_REQUEST = 51
  }

  private val main = Handler(Looper.getMainLooper())
  private var recorder: MediaRecorder? = null
  private var recording = false
  private var finishing = false
  private var startedAt = 0L

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (!CetaMicrophoneRecordModule.attach(this)) {
      finish()
      return
    }
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(48, 96, 48, 48)
    }
    layout.addView(TextView(this).apply { text = "正在录音，离开页面会立即停止" })
    layout.addView(Button(this).apply {
      text = "停止录音"
      setOnClickListener { finishRecording(true, null) }
    })
    setContentView(layout)
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MICROPHONE_REQUEST)
    } else {
      startRecording()
    }
  }

  private fun startRecording() {
    val file = CetaMicrophoneRecordModule.outputFile()
    if (file == null) {
      finishRecording(false, "storage_error")
      return
    }
    try {
      recorder = MediaRecorder().apply {
        setAudioSource(MediaRecorder.AudioSource.MIC)
        setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        setAudioSamplingRate(44_100)
        setAudioEncodingBitRate(128_000)
        setOutputFile(file.absolutePath)
        prepare()
        start()
      }
      recording = true
      startedAt = SystemClock.elapsedRealtime()
      main.postDelayed({
        if (recording) finishRecording(true, null)
      }, 60_000)
    } catch (_: SecurityException) {
      releaseRecorder()
      finishRecording(false, "permission_denied")
    } catch (_: Exception) {
      releaseRecorder()
      finishRecording(false, "unsupported")
    }
  }

  override fun onRequestPermissionsResult(
      requestCode: Int,
      permissions: Array<out String>,
      grants: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grants)
    if (requestCode == MICROPHONE_REQUEST) {
      if (grants.firstOrNull() == PackageManager.PERMISSION_GRANTED) startRecording()
      else finishRecording(false, "permission_denied")
    }
  }

  private fun releaseRecorder() {
    recorder?.reset()
    recorder?.release()
    recorder = null
  }

  private fun finishRecording(success: Boolean, code: String?) {
    if (finishing) return
    finishing = true
    main.removeCallbacksAndMessages(null)
    val duration = if (startedAt == 0L) 0L
        else (SystemClock.elapsedRealtime() - startedAt).coerceAtMost(60_000)
    var completed = success
    if (recording) {
      try {
        recorder?.stop()
      } catch (_: Exception) {
        completed = false
      }
      recording = false
    }
    releaseRecorder()
    CetaMicrophoneRecordModule.completeFrom(
        this,
        completed,
        code ?: if (completed) null else "provider_error",
        duration,
    )
  }

  override fun onPause() {
    if (recording && !finishing) finishRecording(false, "cancelled")
    super.onPause()
  }

  override fun onDestroy() {
    if (recording && !finishing) finishRecording(false, "cancelled")
    releaseRecorder()
    super.onDestroy()
  }
}
