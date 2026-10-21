package com.cetameshmobile.identity

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import java.math.BigInteger
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.SignatureException
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONObject

@ReactModule(name = CetaDeviceIdentityModule.NAME)
class CetaDeviceIdentityModule(context: ReactApplicationContext) :
    NativeCetaDeviceIdentitySpec(context) {
  companion object {
    const val NAME = "CetaDeviceIdentity"
    private const val ALIAS = "com.cetameshmobile.identity.p256.v1"
    private const val RECORD = "identity"
    private const val LIMIT = 16384
    // Process-wide queue also serializes initialization across React host reloads.
    private val queue = Executors.newSingleThreadExecutor()
    private val random = SecureRandom()
    private var persistenceFailed = false
  }

  private class Failure(val code: String) : Exception()
  private val preferences = context.getSharedPreferences(ALIAS, 0)
  override fun getName() = NAME

  private fun run(promise: Promise, operation: () -> Any) {
    queue.execute {
      try {
        promise.resolve(operation())
      } catch (error: Failure) {
        promise.reject(error.code, safeMessage(error.code))
      } catch (_: Exception) {
        // Never send native exception messages, stack traces or key/provider details to JS.
        promise.reject("storage_error", safeMessage("storage_error"))
      }
    }
  }

  private fun safeMessage(code: String) = when (code) {
    "invalid_protocol" -> "Invalid identity input"
    "unsupported" -> "Secure device identity is unsupported"
    else -> "Device identity is unavailable"
  }

  override fun getIdentity(promise: Promise) = run(promise) { identity().second }

  override fun sign(data: String, promise: Promise) = run(promise) {
    val bytes = boundedData(data)
    val key = identity().first
    val signer = Signature.getInstance("SHA256withECDSA")
    signer.initSign(key)
    signer.update(bytes)
    encode(signer.sign())
  }

  override fun verify(publicKey: String, data: String, signature: String, promise: Promise) =
      run(promise) {
        val bytes = boundedData(data)
        val rawKey = decode(publicKey, 88)
        if (rawKey.size != 65 || rawKey[0] != 4.toByte()) throw Failure("invalid_protocol")
        val der = decode(signature, 96)
        if (der.size !in 8..72) throw Failure("invalid_protocol")
        val parameters = AlgorithmParameters.getInstance("EC").apply {
          init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(ECParameterSpec::class.java)
        val point = ECPoint(BigInteger(1, rawKey.copyOfRange(1, 33)), BigInteger(1, rawKey.copyOfRange(33, 65)))
        // Reject off-curve points before handing them to provider-specific implementations.
        val p = (parameters.curve.field as java.security.spec.ECFieldFp).p
        val x = point.affineX
        val y = point.affineY
        if (x >= p || y >= p || y.modPow(BigInteger.valueOf(2), p) !=
            (x.modPow(BigInteger.valueOf(3), p) + parameters.curve.a * x + parameters.curve.b).mod(p)) {
          throw Failure("invalid_protocol")
        }
        val key = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, parameters))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(key)
        verifier.update(bytes)
        try { verifier.verify(der) } catch (_: SignatureException) { false }
      }

  override fun fingerprint(token: String, promise: Promise) = run(promise) {
    val raw = decode(token, 44)
    if (raw.size != 32) throw Failure("invalid_protocol")
    MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
  }

  override fun randomNonce(promise: Promise) = run(promise) {
    encode(ByteArray(32).also { random.nextBytes(it) })
  }

  private fun boundedData(data: String): ByteArray {
    if (data.length > LIMIT) throw Failure("invalid_protocol")
    val encoded = try {
      Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(data))
    } catch (_: Exception) { throw Failure("invalid_protocol") }
    if (encoded.remaining() > LIMIT) throw Failure("invalid_protocol")
    return ByteArray(encoded.remaining()).also { encoded.get(it) }
  }

  private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun decode(value: String, max: Int): ByteArray {
    if (value.isEmpty() || value.length > max) throw Failure("invalid_protocol")
    val bytes = try { Base64.decode(value, Base64.NO_WRAP) }
        catch (_: IllegalArgumentException) { throw Failure("invalid_protocol") }
    if (encode(bytes) != value) throw Failure("invalid_protocol")
    return bytes
  }

  private fun formatter() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
    isLenient = false
  }

  private fun identity(): Pair<PrivateKey, String> {
    if (persistenceFailed) throw Failure("storage_error")
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val hasKey = store.containsAlias(ALIAS)
    val all = preferences.all
    val record = all[RECORD]
    if (!hasKey && all.isEmpty()) {
      // A fixed alias and the serial queue prevent duplicate keys. No deletion/recovery rotation.
      val generator = try {
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
          initialize(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
              .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
              .setDigests(KeyProperties.DIGEST_SHA256)
              .setUserAuthenticationRequired(false)
              .build())
        }
      } catch (_: Exception) { throw Failure("unsupported") }
      val pair = try { generator.generateKeyPair() }
          catch (_: Exception) { throw Failure("unsupported") }
      requireHardware(pair.private)
      val publicKey = publicRepresentation(pair.public as ECPublicKey)
      // UUID.randomUUID is backed by SecureRandom on Android.
      val metadata = JSONObject()
          .put("deviceId", UUID.randomUUID().toString())
          .put("deviceName", Build.MODEL.filter { it >= ' ' && it != '\u007f' }.take(64).trim().ifBlank { "Android device" })
          .put("platform", "android")
          .put("publicKey", publicKey)
          .put("createdAt", formatter().format(Date()))
          .toString()
      // commit is synchronous. Latch failures because SharedPreferences may update RAM first.
      persistenceFailed = true
      if (!preferences.edit().putString(RECORD, metadata).commit()) throw Failure("storage_error")
      persistenceFailed = false
      return pair.private to metadata
    }
    if (!hasKey || record !is String || all.size != 1) throw Failure("storage_error")
    val key = store.getKey(ALIAS, null) as? PrivateKey ?: throw Failure("storage_error")
    requireHardware(key)
    val public = store.getCertificate(ALIAS)?.publicKey as? ECPublicKey ?: throw Failure("storage_error")
    validateRecord(record, publicRepresentation(public))
    return key to record
  }

  @Suppress("DEPRECATION")
  private fun requireHardware(key: PrivateKey) {
    val info = KeyFactory.getInstance("EC", "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
    if (!info.isInsideSecureHardware || info.keySize != 256) throw Failure("unsupported")
  }

  private fun publicRepresentation(key: ECPublicKey): String {
    if (key.params.curve.field.fieldSize != 256) throw Failure("storage_error")
    fun coordinate(value: BigInteger): ByteArray {
      val bytes = value.toByteArray()
      if (bytes.size > 33 || (bytes.size == 33 && bytes[0] != 0.toByte())) throw Failure("storage_error")
      val unsigned = if (bytes.size == 33) bytes.copyOfRange(1, 33) else bytes
      return ByteArray(32 - unsigned.size) + unsigned
    }
    return encode(byteArrayOf(4) + coordinate(key.w.affineX) + coordinate(key.w.affineY))
  }

  private fun validateRecord(record: String, publicKey: String) {
    try {
      if (record.length > 2048) throw Failure("storage_error")
      val json = JSONObject(record)
      val fields = setOf("deviceId", "deviceName", "platform", "publicKey", "createdAt")
      if (json.keys().asSequence().toSet() != fields || fields.any { json.get(it) !is String }) {
        throw Failure("storage_error")
      }
      val id = json.getString("deviceId")
      val name = json.getString("deviceName")
      val date = json.getString("createdAt")
      val position = ParsePosition(0)
      val parsed = formatter().parse(date, position)
      if (!Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").matches(id) ||
          name.isBlank() || name.length > 100 || name.any { it < ' ' || it == '\u007f' } || date.length != 24 || parsed == null ||
          position.index != date.length || formatter().format(parsed) != date ||
          json.getString("platform") != "android" || json.getString("publicKey") != publicKey) {
        throw Failure("storage_error")
      }
    } catch (_: Exception) { throw Failure("storage_error") }
  }
}
