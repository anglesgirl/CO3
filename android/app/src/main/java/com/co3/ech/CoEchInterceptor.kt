package com.co3.ech

import android.util.Base64
import android.util.Log
import com.liar.han1meplus.EchHttpClient
import android.webkit.CookieManager
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject

class CoEchInterceptor : Interceptor {
    companion object {
        private const val TAG = "CO-ECH"
        private const val DOH_URL = "https://82sew1c85i.cloudflare-gateway.com/dns-query"
        private const val DOH_RESOLVE = "82sew1c85i.cloudflare-gateway.com:443:162.159.36.20,162.159.36.5"
        private val TARGET_HOSTS = setOf("archiveofourown.org", "www.archiveofourown.org")
    }

    private fun shouldIntercept(host: String): Boolean {
        if (!EchHttpClient.isLoaded) return false
        return host in TARGET_HOSTS || host.endsWith(".archiveofourown.org")
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val host = request.url.host
        if (!shouldIntercept(host)) return chain.proceed(request)

        val headers = mutableListOf<String>()
        // 注入 WebView 的 Cookie 到 OkHttp
        try {
            val cookie = CookieManager.getInstance().getCookie(request.url.toString())
            if (!cookie.isNullOrEmpty() && request.header("Cookie") == null) {
                headers.add("Cookie: $cookie")
            }
        } catch (_: Exception) {}
        for (i in 0 until request.headers.size) {
            val name = request.headers.name(i)
            val value = request.headers.value(i)
            if (name.equals("Host", true) || name.equals("Content-Length", true)) continue
            headers.add("$name: $value")
        }

        val bodyBytes: ByteArray? = request.body?.let { body ->
            val buffer = Buffer()
            body.writeTo(buffer)
            buffer.readByteArray()
        }

        var lastError: Exception? = null
        repeat(2) { attempt ->
            try {
                val jsonStr = EchHttpClient.request(
                    request.method, request.url.toString(),
                    headers.toTypedArray(), bodyBytes,
                    DOH_URL, DOH_RESOLVE
                )
                val json = JSONObject(jsonStr)
                val statusCode = json.optInt("statusCode", 200)
                val bodyBase64 = json.optString("body", "")
                val echStatus = json.optString("echStatus", "")
                val headersJson = json.optJSONArray("headers")

                // ECH 被拒绝时 echStatus 会含 REJECTED，视为可重试
                if (echStatus.contains("REJECTED", true) || echStatus.contains("ECH", true) && statusCode >= 400) {
                    throw java.io.IOException("ECH_REJECTED: $echStatus")
                }

                val bodyBytesDecoded = if (bodyBase64.isNotEmpty()) Base64.decode(bodyBase64, Base64.DEFAULT) else ByteArray(0)
                var contentType: MediaType? = null
                if (headersJson != null) {
                    for (i in 0 until headersJson.length()) {
                        val h = headersJson.optString(i) ?: continue
                        val idx = h.indexOf('\t')
                        if (idx > 0 && h.substring(0, idx).equals("content-type", true)) {
                            contentType = h.substring(idx + 1).toMediaTypeOrNull()
                            break
                        }
                    }
                }
                val responseBody = bodyBytesDecoded.toResponseBody(contentType)
                val builder = Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(statusCode)
                    .message(echStatus.ifEmpty { "OK" })
                    .body(responseBody)

                val responseHeaders = Headers.Builder()
                if (headersJson != null) {
                    for (i in 0 until headersJson.length()) {
                        val h = headersJson.optString(i) ?: continue
                        val idx = h.indexOf('\t')
                        if (idx <= 0) continue
                        responseHeaders.add(h.substring(0, idx), h.substring(idx + 1))
                    }
                }
                builder.headers(responseHeaders.build())
                com.co3.Diagnostics.event("ech_ok", mapOf("host" to host, "status" to statusCode, "ech" to echStatus))
                Log.i(TAG, "ECH OK $host -> $statusCode $echStatus attempt=${attempt+1}")
                return builder.build()
            } catch (e: Exception) {
                lastError = e
                val isEch = e.message?.contains("ECH", true) == true || e.message?.contains("REJECTED", true) == true
                com.co3.Diagnostics.event("ech_fail", mapOf("host" to host, "attempt" to (attempt+1), "error" to (e.message ?: "unknown")))
                Log.w(TAG, "ECH fail $host attempt ${attempt+1}: ${e.message} isEch=$isEch")
                if (!isEch || attempt == 1) {
                    // 非 ECH 错误或已重试，直接回落明文（过期期间保可用）
                    return chain.proceed(request)
                }
                try { Thread.sleep(300) } catch (_: Exception) {}
            }
        }
        Log.e(TAG, "ECH retry exhausted $host: ${lastError?.message}")
        return chain.proceed(request)
    }
}
