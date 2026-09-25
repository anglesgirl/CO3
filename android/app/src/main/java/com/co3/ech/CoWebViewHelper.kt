package com.co3.ech

import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.co3.Diagnostics
import okhttp3.Request
import java.io.ByteArrayInputStream

/**
 * WebView 子请求的唯一入口（shouldInterceptRequest）：
 * WebView 里发起的图片/脚本/页面请求无法被 RN 层拦截，必须在这里接管。
 *
 * 改造要点（原来走 JNI + libcurl，现改为 OkHttp + Conscrypt）：
 *   - 传输、重定向、Cookie 全部交给 OkHttp 标准语义，这里只做"翻译"（OkHttp Response -> WebResourceResponse）
 *   - Cookie 由 EchHttp.client 的 cookieJar（同一 CookieManager）注入，WebView 传来的 Cookie 头跳过以免打架
 *   - 任何失败一律 fail-closed（返回 502 页面），绝不放行明文 SNI
 */
object CoWebViewHelper {

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val host = request.url.host ?: return null
        val url = request.url.toString()
        if (!ConscryptEch.ready && !ConscryptEch.install()) return null
        try {
            var builder = Request.Builder().url(url).get()
            request.requestHeaders.forEach { (k, v) ->
                if (k.equals("Host", true) || k.equals("Content-Length", true) || k.equals("Cookie", true)) return@forEach
                try { builder.header(k, v) } catch (_: Exception) {}
            }
            EchHttp.client.newCall(builder.build()).execute().use { resp ->
                val body = resp.body?.bytes() ?: ByteArray(0)
                return WebResourceResponse(
                    resp.header("Content-Type")?.split(";")?.firstOrNull()?.trim() ?: "text/html",
                    "utf-8", resp.code, resp.message.ifEmpty { "OK" },
                    resp.headers.toMultimap(), ByteArrayInputStream(body),
                )
            }
        } catch (e: Exception) {
            if (!EchHosts.isProtected(host)) return null
            return WebResourceResponse(
                "text/html", "utf-8", 502, "Bad Gateway",
                mapOf("Cache-Control" to "no-store"),
                ByteArrayInputStream("<!DOCTYPE html><html><body><h3>ECH 失败</h3><p>${(e.message?:"").replace("<","&lt;")}</p></body></html>".toByteArray()),
            )
        }
    }
}
