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
        val method = request.method ?: "GET"
        val url = request.url.toString()

        // 登录 POST 完全放行：交给 JS 劫持（postLogin）走原生 ECH POST + 渲染结果
        if (method == "POST" && url.contains("/users/login")) {
            Diagnostics.event("webview_login_post_passthrough", mapOf("url" to url.take(80)))
            return null
        }
        // 非 GET 不拦截（WebView 的 POST body 取不到）
        if (method != "GET") return null
        if (!ConscryptEch.ready) {
            Diagnostics.event("webview_ech_not_ready", mapOf("host" to host))
            return null
        }

        var lastError: String = "unknown"
        repeat(2) { attempt ->
            try {
                var hasSession = false
                try {
                    val cmCookie = CookieManager.getInstance().getCookie(url)
                    hasSession = cmCookie?.contains("_otwarchive_session") == true
                    Diagnostics.event(
                        "webview_cookie_send",
                        mapOf("host" to host, "hasSession" to hasSession.toString(), "len" to (cmCookie?.length ?: 0).toString()),
                    )
                } catch (e: Exception) {
                    Diagnostics.event("webview_cookie_err", mapOf("host" to host, "err" to (e.message ?: "")))
                }

                val builder = Request.Builder().url(url).get()
                request.requestHeaders.forEach { (k, v) ->
                    // Cookie 交给 cookieJar 统一注入；Host/Content-Length 由 OkHttp 自己管
                    if (k.equals("Host", true) || k.equals("Content-Length", true)) return@forEach
                    if (k.equals("Cookie", true)) return@forEach
                    try {
                        builder.header(k, v)
                    } catch (_: Exception) {
                    }
                }

                EchHttp.client.newCall(builder.build()).execute().use { resp ->
                    val bodyBytes = resp.body?.bytes() ?: ByteArray(0)
                    val contentType = resp.header("Content-Type") ?: "text/html"
                    var mimeType = "text/html"
                    var encoding = "utf-8"
                    contentType.split(";").forEachIndexed { idx, part ->
                        if (idx == 0) mimeType = part.trim().ifEmpty { "text/html" }
                        else if (part.trim().startsWith("charset=", true)) {
                            encoding = part.trim().substringAfter("=").trim()
                        }
                    }

                    val responseHeaders = LinkedHashMap<String, String>()
                    for (name in resp.headers.names()) {
                        responseHeaders[name] = resp.headers.get(name) ?: ""
                    }

                    // Set-Cookie 诊断（值脱敏只记特征）+ 兼容旧行为的属性改写，确保 WebView 能收下 user_credentials
                    try {
                        val cm = CookieManager.getInstance()
                        var sessionCount = 0
                        for (raw in resp.headers.values("Set-Cookie")) {
                            var fixed = raw
                            fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                            fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                            fixed = fixed.replace(Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE), "; SameSite=Lax")
                            cm.setCookie(url, fixed)
                            try {
                                cm.setCookie("https://archiveofourown.org/", fixed)
                            } catch (_: Exception) {
                            }
                            if (raw.contains("_otwarchive_session")) {
                                sessionCount++
                                Diagnostics.event("webview_cookie_recv_session", mapOf("host" to host))
                            }
                            if (raw.contains("user_credentials")) {
                                Diagnostics.event("webview_cookie_recv_creds", mapOf("host" to host))
                            }
                        }
                        cm.flush()
                        if (sessionCount > 0) {
                            Diagnostics.event("webview_cookie_recv", mapOf("host" to host, "sessionCount" to sessionCount.toString()))
                        }
                    } catch (e: Exception) {
                        Diagnostics.event("webview_cookie_recv_err", mapOf("host" to host, "err" to (e.message ?: "")))
                    }

                    val redirected = if (resp.priorResponse != null) "yes" else "no"
                    Diagnostics.event(
                        "webview_ok",
                        mapOf(
                            "host" to host,
                            "code" to resp.code.toString(),
                            "len" to bodyBytes.size.toString(),
                            "redirected" to redirected,
                            "hasSession" to hasSession.toString(),
                        ),
                    )
                    return WebResourceResponse(
                        mimeType,
                        encoding,
                        resp.code,
                        resp.message.ifEmpty { "OK" },
                        responseHeaders,
                        ByteArrayInputStream(bodyBytes),
                    )
                }
            } catch (e: Exception) {
                lastError = e.message ?: e.javaClass.simpleName
                Diagnostics.event("webview_fail", mapOf("host" to host, "attempt" to (attempt + 1).toString(), "err" to lastError.take(120)))
                if (attempt == 0) {
                    // ECH 配置可能是旧的：清一次缓存再试（EchRetryInterceptor 也做同样的事，这里是双保险）
                    EchDoh.invalidateEch(host)
                    try {
                        Thread.sleep(300)
                    } catch (_: Exception) {
                    }
                }
            }
        }

        // fail-closed：宁可这个请求失败，也不以明文 SNI 直连
        Diagnostics.event("ech_fail_webview", mapOf("host" to host, "err" to lastError.take(120)))
        val page = "<!DOCTYPE html><html><body><h3>ECH 连接失败（fail-closed）</h3><p>${lastError.replace("<", "&lt;")}</p></body></html>"
        return WebResourceResponse(
            "text/html",
            "utf-8",
            502,
            "Bad Gateway",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(page.toByteArray()),
        )
    }
}
