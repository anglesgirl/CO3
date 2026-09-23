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

    /** H3 只接管可缓存、不带会话的静态资源（图片/样式/脚本/字体）。 */
    private val STATIC_EXT = setOf(
        "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "ico", "svg",
        "css", "js", "mjs", "woff", "woff2", "ttf",
    )

    private fun isStaticAsset(uri: android.net.Uri): Boolean {
        val ext = (uri.path ?: return false).substringAfterLast('.', "").lowercase()
        return ext in STATIC_EXT
    }

    private fun mimeFor(uri: android.net.Uri): String = when (
        (uri.path ?: "").substringAfterLast('.', "").lowercase()
    ) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "avif" -> "image/avif"
        "svg" -> "image/svg+xml"
        "css" -> "text/css"
        "js", "mjs" -> "application/javascript"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "ttf" -> "font/ttf"
        else -> "application/octet-stream"
    }

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val originalHost = request.url.host ?: return null
        val method = request.method ?: "GET"

        // ★ 别名改写：源域名不可达时换成等价镜像域名（表在远程 TXT，改镜像不用发版）。
        //   关键点：换的是**域名**不是 IP —— 实测把 ajax 指向 fonts 的国内节点没用，
        //   那些节点是特化的、不给 ajax.googleapis.com 提供服务；而等价镜像域名
        //   返回的文件逐字节相同（SRI 校验也过）。
        //   只在表里有这个域名时才改写，读不到表就完全保持原行为。
        val alias = runCatching { EchDoh.hostAlias(originalHost) }.getOrNull()
        val effectiveUrl = if (alias != null) {
            val rewritten = request.url.buildUpon().authority(alias).build()
            Diagnostics.event(
                "alias.rewrite",
                mapOf("host" to originalHost, "to" to alias, "path" to (request.url.path ?: "").take(60)),
            )
            rewritten
        } else {
            request.url
        }

        val host = effectiveUrl.host ?: originalHost
        val url = effectiveUrl.toString()

        // 登录 POST 完全放行：交给 JS 劫持（postLogin）走原生 ECH POST + 渲染结果
        if (method == "POST" && url.contains("/users/login")) {
            Diagnostics.event("webview_login_post_passthrough", mapOf("url" to url.take(80)))
            return null
        }
        // 非 GET 不拦截（WebView 的 POST body 取不到）
        if (method != "GET") return null

        // H3 优先（用户定调：**默认所有域名都先试 H3**）。失败时 CoEchH3 会把这个域名记入负缓存
        // （24h），本次请求立刻回落到下面的 H2（TCP+ECH）链路 —— 用户无感。
        // 只接管「静态、不带会话」的资源：HTML/POST/Cookie 相关请求必须走 TCP+ECH，
        // 因为 H3 这条不发送 Cookie，会把已登录状态读成未登录。
        if (isStaticAsset(request.url)) {
            val h3 = runCatching { CoEchH3.fetchResourceToFile(request.url.toString()) }.getOrNull()
            if (h3 != null && h3.exists() && h3.length() > 0) {
                Diagnostics.event("webview_h3_hit", mapOf("host" to host, "len" to h3.length().toString()))
                return WebResourceResponse(
                    mimeFor(request.url), null, 200, "OK", emptyMap(), java.io.FileInputStream(h3),
                )
            }
        }
        // 惰性确保：ready 为 false 时主动初始化一次（幂等、不抛异常）。
        // 注意拦截器不在启动路径上，这里首次调用时 SoLoader/Fresco 早已就绪。
        if (!ConscryptEch.ready && !ConscryptEch.install()) {
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

        // ★ fail-closed 只对**受保护域名**生效。
        //
        // 以前这里对任何 host 失败都返回「ECH 连接失败」502 HTML —— 后果是：
        // 第三方 JS/CSS/图床连不上时，浏览器拿到一段「声称是 document 的 HTML」去当 JS 执行，
        // 页面脚本直接崩，上层表现成「登录坏了 / 页面功能失灵」，而真实原因只是某个无关域名连不上。
        // **那是把无关故障归因给 ECH。**
        //
        // 非保护域失败就如实返回 null，让 WebView 按正常语义处理（它自己的错误页/重试）。
        if (!EchHosts.isProtected(host)) {
            Diagnostics.event(
                "webview_fail_passthrough",
                mapOf("host" to host, "err" to lastError.take(120), "note" to "非保护域，交回 WebView 处理"),
            )
            return null
        }

        // 受保护域名：fail-closed —— 宁可这个请求失败，也不以明文 SNI 直连
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
