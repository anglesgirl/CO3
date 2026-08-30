package com.co3.ech

import android.util.Base64
import android.util.Log
import com.co3.Diagnostics
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
        // 注入 WebView 的 Cookie 到 OkHttp（双向同步核心）
        var cookieHasSession = false
        var cookieLen = 0
        try {
            val cookie = CookieManager.getInstance().getCookie(request.url.toString())
            cookieLen = cookie?.length ?: 0
            cookieHasSession = cookie?.contains("_otwarchive_session") == true
            if (!cookie.isNullOrEmpty() && request.header("Cookie") == null) {
                headers.add("Cookie: $cookie")
            }
            Diagnostics.event("cookie_send", mapOf("host" to host, "hasSession" to cookieHasSession.toString(), "len" to cookieLen.toString(), "url" to request.url.toString().take(80)))
            android.util.Log.i("CO-COOKIE", "OkHttp send $host hasSession=$cookieHasSession len=$cookieLen")
        } catch (e: Exception) { Diagnostics.event("cookie_send_err", mapOf("host" to host, "err" to (e.message?:""))) }
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
                val useDohUrl = if (attempt == 0) DOH_URL else DOH_URL + (if (DOH_URL.contains("?")) "&" else "?") + "_=" + System.currentTimeMillis()
                val jsonStr = EchHttpClient.request(
                    request.method, request.url.toString(),
                    headers.toTypedArray(), bodyBytes,
                    useDohUrl, DOH_RESOLVE
                )
                val json = JSONObject(jsonStr)
                val statusCode = json.optInt("statusCode", 200)
                val bodyBase64 = json.optString("body", "")
                val echStatus = json.optString("echStatus", "")
                val headersJson = json.optJSONArray("headers")

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
                val setCookies = mutableListOf<String>()
                if (headersJson != null) {
                    for (i in 0 until headersJson.length()) {
                        val h = headersJson.optString(i) ?: continue
                        val idx = h.indexOf('\t')
                        if (idx <= 0) continue
                        val n = h.substring(0, idx)
                        val v = h.substring(idx + 1)
                        responseHeaders.add(n, v)
                        if (n.equals("set-cookie", true)) setCookies.add(v)
                    }
                }
                builder.headers(responseHeaders.build())
                // 同步 Set-Cookie 回 CookieManager（解决章节/下载认证）
                try {
                    val cm = CookieManager.getInstance()
                    val urlStr = request.url.toString()
                    for (sc in setCookies) {
                        cm.setCookie(urlStr, sc)
                        val isSession = sc.contains("_otwarchive_session")
                        if (isSession) {
                            Diagnostics.event("cookie_recv_session", mapOf("host" to host, "url" to urlStr.take(80), "cookie" to sc.take(140)))
                            android.util.Log.i("CO-COOKIE", "recv session cookie $sc")
                        }
                    }
                    if (setCookies.isNotEmpty()) { cm.flush(); Diagnostics.event("cookie_recv", mapOf("host" to host, "count" to setCookies.size.toString(), "hasSession" to setCookies.any{it.contains("_otwarchive_session")}.toString())) }
                } catch (e: Exception) { Diagnostics.event("cookie_recv_err", mapOf("host" to host, "err" to (e.message?:""))) }
                com.co3.Diagnostics.event("ech_ok", mapOf("host" to host, "status" to statusCode, "ech" to echStatus))
                Log.i(TAG, "ECH OK $host -> $statusCode $echStatus attempt=${attempt+1}")
                return builder.build()
            } catch (e: Exception) {
                lastError = e
                // fail-closed：对 ECH 目标域名的请求，任何连接失败都按 ECH 失败处理。
                // 错误消息可能是 "SSL connect error"（BoringSSL 握手失败）而非含 "ECH"，不能放行明文 SNI。
                val isEch = true
                com.co3.Diagnostics.event("ech_fail", mapOf("host" to host, "attempt" to (attempt+1), "error" to (e.message ?: "unknown")))
                Log.w(TAG, "ECH fail $host attempt ${attempt+1}: ${e.message} isEch=$isEch")
                if (!isEch || attempt == 1) {
                    // fail-closed：不放行明文直连（会暴露 SNI），重试耗尽后抛异常
                    throw e
                }
                
                // 回落：用同一 Gateway 查 cloudflare-ech.com 刷新全局 ECH（绕缓存）
                try {
                    val warmUrl = DOH_URL + (if (DOH_URL.contains("?")) "&" else "?") + "name=cloudflare-ech.com&type=65&_=" + System.currentTimeMillis()
                    val wReq = okhttp3.Request.Builder().url(warmUrl).addHeader("Accept", "application/dns-json").build()
                    val wCli = okhttp3.OkHttpClient.Builder().connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS).readTimeout(5, java.util.concurrent.TimeUnit.SECONDS).build()
                    wCli.newCall(wReq).execute().use { resp -> resp.body?.string() }
                    android.util.Log.i("CO-ECH", "warm cloudflare-ech.com via Gateway done")
                    com.co3.Diagnostics.event("ech_warm_cf", mapOf("host" to host, "err" to (e.message ?: "")))
                } catch (_: Exception) {}
                // 通知 ech-sync Worker 立即更新 x.xn--pn1aul.eu.org 的 HTTPS 记录（App 专用 key；失败不影响主流程）
                try {
                    val notifyReq = okhttp3.Request.Builder()
                        .url("https://ech-sync.lintoya.workers.dev/?key=a1b6071f9147b44e0b1e08b25aee9ee3")
                        .get().build()
                    val notifyCli = okhttp3.OkHttpClient.Builder()
                        .connectTimeout(3, java.util.concurrent.TimeUnit.SECONDS)
                        .readTimeout(3, java.util.concurrent.TimeUnit.SECONDS)
                        .build()
                    notifyCli.newCall(notifyReq).execute().use { resp -> resp.body?.string() }
                    try { com.co3.Diagnostics.event("ech_sync_notify", mapOf("host" to host, "status" to "ok")) } catch (_: Exception) {}
                } catch (e: Exception) {
                    try { com.co3.Diagnostics.event("ech_sync_notify_fail", mapOf("host" to host, "err" to (e.message ?: "unknown"))) } catch (_: Exception) {}
                }

                try { Thread.sleep(300) } catch (_: Exception) {}
            }
        }
        Log.e(TAG, "ECH retry exhausted $host: ${lastError?.message}")
        // fail-closed：重试耗尽后抛异常，绝不放行明文 SNI
        throw lastError ?: java.io.IOException("ECH failed: $host")
    }
}
