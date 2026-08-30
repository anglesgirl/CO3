package com.co3.ech

import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.liar.han1meplus.EchHttpClient
import org.json.JSONObject
import java.io.ByteArrayInputStream

object CoWebViewHelper {
    private val targetHosts = setOf("archiveofourown.org", "www.archiveofourown.org")

    private fun shouldIntercept(host: String?): Boolean {
        if (host == null) return false
        if (!EchHttpClient.isLoaded) return false
        return host in targetHosts || host.endsWith(".archiveofourown.org")
    }

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val host = request.url.host ?: return null
        if (!shouldIntercept(host)) return null
        repeat(2) { attempt ->
            try {
                val url = request.url.toString()
                val method = request.method ?: "GET"
                // 注入 CookieManager 的 cookie（解决官方登录后 Session Expired）
                val headersList = mutableListOf<String>()
                try {
                    val cmCookie = CookieManager.getInstance().getCookie(url)
                    if (!cmCookie.isNullOrEmpty()) {
                        // 避免重复 Cookie 头
                        val hasCookie = request.requestHeaders.keys.any { it.equals("Cookie", true) }
                        if (!hasCookie) headersList.add("Cookie: $cmCookie")
                    }
                } catch (_: Exception) {}
                for ((k,v) in request.requestHeaders) {
                    if (k.equals("Host", true) || k.equals("Content-Length", true)) continue
                    if (k.equals("Cookie", true) && headersList.any { it.startsWith("Cookie:") }) continue
                    headersList.add("$k: $v")
                }
                val headers = headersList.toTypedArray()
                val dohUrl = "https://82sew1c85i.cloudflare-gateway.com/dns-query"
                val dohResolve = "82sew1c85i.cloudflare-gateway.com:443:162.159.36.20,162.159.36.5"
                val useDohUrl = if (attempt == 0) dohUrl else dohUrl + (if (dohUrl.contains("?")) "&" else "?") + "_=" + System.currentTimeMillis()
                val jsonStr = EchHttpClient.request(method, url, headers, null, useDohUrl, dohResolve)
                val json = JSONObject(jsonStr)
                val statusCode = json.optInt("statusCode", 200)
                val echStatus = json.optString("echStatus", "")
                if (echStatus.contains("REJECTED", true)) throw java.io.IOException("ECH_REJECTED: $echStatus")
                val bodyBase64 = json.optString("body", "")
                val headersJson = json.optJSONArray("headers")
                val bodyBytes = if (bodyBase64.isNotEmpty()) Base64.decode(bodyBase64, Base64.DEFAULT) else ByteArray(0)
                var mimeType = "text/html"
                var encoding = "utf-8"
                val responseHeaders = mutableMapOf<String, String>()
                if (headersJson != null) {
                    for (i in 0 until headersJson.length()) {
                        val h = headersJson.optString(i) ?: continue
                        val idx = h.indexOf('\t')
                        if (idx <= 0) continue
                        val name = h.substring(0, idx)
                        val value = h.substring(idx + 1)
                        responseHeaders[name] = value
                        if (name.equals("content-type", true)) {
                            val parts = value.split(";")
                            mimeType = parts[0].trim()
                            parts.forEach { p -> if (p.trim().startsWith("charset=", true)) encoding = p.trim().substringAfter("=") }
                        }
                    }
                }
                val stream = ByteArrayInputStream(bodyBytes)
                // 同步 Set-Cookie 到 CookieManager（OkHttp与WebView共用）
                try {
                    val cm = CookieManager.getInstance()
                    for ((k, v) in responseHeaders) {
                        if (k.equals("set-cookie", true)) {
                            // AO3 可能一次返回多条 set-cookie 合并，需拆分
                            // EchHttpClient 已按头拆分，这里每条单独 set
                            cm.setCookie(url, v)
                        }
                    }
                    cm.flush()
                } catch (_: Exception) {}
                return WebResourceResponse(mimeType, encoding, statusCode, "OK", responseHeaders, stream)
            } catch (e: Exception) {
                val isEch = e.message?.contains("ECH", true) == true || e.message?.contains("REJECTED", true) == true
                if (!isEch || attempt == 1) return null
                
                // 回落：用同一 Gateway 查 cloudflare-ech.com 刷新全局 ECH（绕缓存）
                try {
                    val warmUrl = dohUrl + (if (dohUrl.contains("?")) "&" else "?") + "name=cloudflare-ech.com&type=65&_=" + System.currentTimeMillis()
                    val wReq = okhttp3.Request.Builder().url(warmUrl).header("Accept", "application/dns-json").build()
                    val wCli = okhttp3.OkHttpClient.Builder().connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS).readTimeout(5, java.util.concurrent.TimeUnit.SECONDS).build()
                    wCli.newCall(wReq).execute().use { resp -> resp.body?.string() }
                    android.util.Log.i("CO-ECH", "warm cloudflare-ech.com via Gateway done")
                } catch (_: Exception) {}

                try { Thread.sleep(300) } catch (_: Exception) {}
            }
        }
        return null
    }
}
