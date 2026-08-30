package com.co3.ech

import android.util.Base64
import android.util.Log
import com.liar.han1meplus.EchHttpClient
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

        return try {
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
            Log.i(TAG, "ECH OK $host -> $statusCode $echStatus")
            builder.build()
        } catch (e: Exception) {
            Log.e(TAG, "ECH fail $host: ${e.message}, fallback")
            chain.proceed(request)
        }
    }
}
