package com.co3.ech

import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.co3.Diagnostics
import com.liar.han1meplus.EchHttpClient
import org.json.JSONObject
import java.io.ByteArrayInputStream

object CoWebViewHelper {
    private fun shouldIntercept(host: String?): Boolean {
        if (host == null) return false
        if (!EchHttpClient.isLoaded) return false
        // 所有请求都进 ECH 保护（DoH 网关注入 ECHConfig；无 ECH 的域名由 BoringSSL 回落正常 TLS）
        return true
    }

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val host = request.url.host ?: return null
        // WebView 的 POST 拿不到 body（shouldInterceptRequest 无 body），旧 Go 是走 HTTP 代理所以能拿到。
        // 这里 GET 才走 ECH，POST 放行让 WebView 直连，否则登录表单 body 丢失永远 Session Expired
        val method = request.method ?: "GET"
        val url = request.url.toString()
        // 登录 POST 特殊处理：返回 502 引导 JS 劫持接管（避免裸连被 GFW 重置）
        val isLoginPost = method == "POST" && url.contains("/users/login")
        if (method != "GET" && !isLoginPost) return null
        if (isLoginPost) {
            Diagnostics.event("webview_login_post_intercept", mapOf("url" to url.take(80)))
            return WebResourceResponse(
                "text/html", "utf-8", 502,
                "Use JS Hijack",
                mapOf("X-Co3-Use-Hijack" to "1"),
                ByteArrayInputStream("".toByteArray())
            )
        }
        if (!shouldIntercept(host)) return null
        repeat(2) { attempt ->
            val dohUrl = "https://82sew1c85i.cloudflare-gateway.com/dns-query"
            val dohResolve = "82sew1c85i.cloudflare-gateway.com:443:162.159.36.20,162.159.36.5"
            try {
                val url = request.url.toString()
                // method 已在外层校验为 GET
                // 注入 CookieManager 的 cookie（解决官方登录后 Session Expired）
                val headersList = mutableListOf<String>()
                var hasSession = false
                try {
                    val cmCookie = CookieManager.getInstance().getCookie(url)
                    hasSession = cmCookie?.contains("_otwarchive_session") == true
                    Diagnostics.event("webview_cookie_send", mapOf("host" to host, "hasSession" to hasSession.toString(), "len" to (cmCookie?.length?:0).toString()))
                    android.util.Log.i("CO-COOKIE", "WebView send $host hasSession=$hasSession")
                    if (!cmCookie.isNullOrEmpty()) {
                        val hasCookie = request.requestHeaders.keys.any { it.equals("Cookie", true) }
                        if (!hasCookie) headersList.add("Cookie: $cmCookie")
                    }
                } catch (e: Exception) { Diagnostics.event("webview_cookie_err", mapOf("host" to host, "err" to (e.message?:""))) }
                for ((k,v) in request.requestHeaders) {
                    if (k.equals("Host", true) || k.equals("Content-Length", true)) continue
                    if (k.equals("Cookie", true) && headersList.any { it.startsWith("Cookie:") }) continue
                    headersList.add("$k: $v")
                }
                val headers = headersList.toTypedArray()
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
                    var sessionCount=0
                    for ((k, v) in responseHeaders) {
                        if (k.equals("set-cookie", true)) {
                            // 同 CoEchInterceptor：去 Domain/Secure，避免 WebView 拒收 user_credentials
                            var fixed = v
                            fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                            fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                            fixed = fixed.replace(Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE), "; SameSite=Lax")
                            cm.setCookie(url, fixed)
                            try { cm.setCookie("https://archiveofourown.org/", fixed) } catch(_:Exception){}
                            if (v.contains("_otwarchive_session")) { sessionCount++; Diagnostics.event("webview_cookie_recv_session", mapOf("host" to host, "cookie" to v.take(140))) }
                            if (v.contains("user_credentials")) Diagnostics.event("webview_cookie_recv_creds", mapOf("host" to host, "cookie" to v.take(140)))
                        }
                    }
                    cm.flush()
                    if (sessionCount>0) android.util.Log.i("CO-COOKIE", "WebView recv $sessionCount session cookies")
                } catch (e: Exception) { Diagnostics.event("webview_cookie_recv_err", mapOf("host" to host, "err" to (e.message?:"")))}
                return WebResourceResponse(mimeType, encoding, statusCode, "OK", responseHeaders, stream)
            } catch (e: Exception) {
                // fail-closed：对 ECH 目标域名的请求，任何连接失败都按 ECH 失败处理。
                // 错误消息可能是 "SSL connect error"（BoringSSL 握手失败）而非含 "ECH"，不能放行明文 SNI。
                val isEch = true

                // 回落：用同一 Gateway 查 cloudflare-ech.com 刷新全局 ECH（绕缓存）
                try {
                    val warmUrl = dohUrl + (if (dohUrl.contains("?")) "&" else "?") + "name=cloudflare-ech.com&type=65&_=" + System.currentTimeMillis()
                    val wReq = okhttp3.Request.Builder().url(warmUrl).addHeader("Accept", "application/dns-json").build()
                    val wCli = okhttp3.OkHttpClient.Builder().connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS).readTimeout(5, java.util.concurrent.TimeUnit.SECONDS).build()
                    wCli.newCall(wReq).execute().use { resp -> resp.body?.string() }
                    android.util.Log.i("CO-ECH", "warm cloudflare-ech.com via Gateway done")
                    Diagnostics.event("ech_warm_cf", mapOf("host" to host, "err" to (e.message ?: "")))
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
                    try { Diagnostics.event("ech_sync_notify", mapOf("host" to host, "status" to "ok")) } catch (_: Exception) {}
                } catch (e2: Exception) {
                    try { Diagnostics.event("ech_sync_notify_fail", mapOf("host" to host, "err" to (e2.message ?: "unknown"))) } catch (_: Exception) {}
                }

                if (attempt == 0) {
                    try { Thread.sleep(300) } catch (_: Exception) {}
                    return@repeat
                }
                // 重试仍失败：返回错误响应（fail-closed，不暴露 SNI）
                Diagnostics.event("ech_fail_webview", mapOf("host" to host, "err" to (e.message ?: "unknown")))
                return WebResourceResponse(
                    "text/html", "utf-8", 502,
                    "ECH Connection Failed",
                    mapOf("Cache-Control" to "no-store"),
                    ByteArrayInputStream("<!DOCTYPE html><html><body><h3>ECH 连接失败 (fail-closed)</h3><p>${e.message?.let { it.replace("<","&lt;") } ?: "unknown"}</p></body></html>".toByteArray())
                )
            }
        }
        return null
    }
}
