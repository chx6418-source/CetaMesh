package com.cetameshmobile.pairing

import com.cetameshmobile.identity.NativeCetaPairingTransportSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private val PIN_PATTERN = Regex("[0-9a-f]{64}")

@ReactModule(name = "CetaPairingTransport")
class CetaPairingTransportModule(context: ReactApplicationContext) : NativeCetaPairingTransportSpec(context) {
  private val calls = ConcurrentHashMap<String,Call>()
  private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
      .retryOnConnectionFailure(false).cookieJar(CookieJar.NO_COOKIES).callTimeout(15,TimeUnit.SECONDS).build()
  override fun getName() = "CetaPairingTransport"
  override fun post(url: String, body: String, requestId: String, tlsPin: String?, promise: Promise) {
    val parsed = try {URI(url)} catch (_: Exception) {null}
    val bytes = body.toByteArray(Charsets.UTF_8)
    if (parsed == null || parsed.scheme != "https" || !allowedHost(parsed.host) ||
        (parsed.port != -1 && (parsed.port !in 1..65535 || parsed.port == 443)) ||
        parsed.rawAuthority != parsed.host + (if(parsed.port == -1) "" else ":${parsed.port}") || parsed.userInfo != null ||
        parsed.query != null || parsed.fragment != null || parsed.path !in listOf("/cetamesh/v1/pairing/exchange","/cetamesh/v1/pairing/confirm") ||
        url.length > 1024 || bytes.size > 16384 || !Regex("pairing-request-[0-9]+").matches(requestId) ||
        (tlsPin != null && !PIN_PATTERN.matches(tlsPin))) {
      promise.reject("invalid_protocol","Invalid pairing request");return
    }
    val call = try {
      val payload = object : RequestBody() {
        override fun contentType() = "application/json; charset=utf-8".toMediaType()
        override fun contentLength() = bytes.size.toLong()
        override fun isOneShot() = true
        override fun writeTo(sink: BufferedSink) {sink.write(bytes)}
      }
      requestClient(tlsPin).newCall(Request.Builder().url(url).header("Accept","application/json").post(payload).build())
    } catch (_: Exception) {promise.reject("invalid_protocol","Invalid pairing request");return}
    if (calls.putIfAbsent(requestId,call) != null) {promise.reject("invalid_protocol","Duplicate request");return}
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        calls.remove(requestId,call)
        promise.reject(if(call.isCanceled()) "cancelled" else "network_unavailable","Pairing request failed")
      }
      override fun onResponse(call: Call, response: Response) {
        response.use {
          try {
            if (it.code != 200) {
              promise.reject(if(it.code==401 || it.code==403) "unauthorized" else "invalid_protocol","Pairing request failed");return
            }
            val input = it.body?.byteStream() ?: throw IOException()
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            while(true) {val n=input.read(buffer);if(n<0) break;if(output.size()+n>32768) {promise.reject("invalid_protocol","Invalid pairing response");return};output.write(buffer,0,n)}
            promise.resolve(output.toString("UTF-8"))
          } catch (_: Exception) {promise.reject("network_unavailable","Pairing request failed")}
          finally {calls.remove(requestId,call)}
        }
      }
    })
  }
  override fun cancel(requestId: String) {calls.remove(requestId)?.cancel()}
  override fun invalidate() {calls.values.forEach {it.cancel()};calls.clear();super.invalidate()}
  // A pinned request builds its own client so the invitation's certificate pin
  // (SHA-256 of the peer leaf certificate DER) is scoped to that single call.
  // Without a pin the shared default-validation client is used unchanged and no
  // static/global TLS override is ever installed.
  private fun requestClient(tlsPin: String?): OkHttpClient {
    if (tlsPin == null) return client
    val pin = PinContext(tlsPin)
    val context = SSLContext.getInstance("TLS")
    context.init(null,arrayOf<TrustManager>(pin.trustManager),null)
    return client.newBuilder().sslSocketFactory(context.socketFactory,pin.trustManager)
        .hostnameVerifier {_,_ -> pin.matched()}.build()
  }
  private class PinContext(private val pin: String) {
    private val flag = AtomicBoolean(false)
    fun matched() = flag.get()
    val trustManager: X509TrustManager = object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {throw CertificateException("Client certificates are not supported")}
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        // The pin replaces public-CA validation for this request only; anything
        // other than an exact leaf fingerprint match fails the connection.
        val leaf = chain?.firstOrNull() ?: throw CertificateException("Peer certificate is missing")
        val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
        val actual = digest.joinToString("") {String.format("%02x",it)}
        if (!MessageDigest.isEqual(actual.toByteArray(Charsets.UTF_8),pin.toByteArray(Charsets.UTF_8))) {
          throw CertificateException("Pairing certificate pin mismatch")
        }
        flag.set(true)
      }
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
  }
  private fun allowedHost(host: String?): Boolean {
    if (host == null || host.length > 253 || host == "localhost" || host.endsWith(".localhost") ||
        host.split('.').any {!Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?").matches(it)}) return false
    if (Regex("[0-9.]+").matches(host) || Regex("[0-9]+|0x[0-9a-f]+").matches(host.substringAfterLast('.'))) {
      val parts=host.split('.')
      return parts.size==4 && parts.all {Regex("0|[1-9][0-9]{0,2}").matches(it) && (it.toIntOrNull() ?: 256)<=255} && parts[0]!="127" && parts[0]!="0"
    }
    return true
  }
}
