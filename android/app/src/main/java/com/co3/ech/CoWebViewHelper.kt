package com.co3.ech

import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.co3.Diagnostics
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * WebView 子请求的唯一入口（shouldInterceptRequest）。
 *
 * 引擎版（ech_http 接管，2026-09-30）：C++ 引擎**不监听端口**，所以这里不再把
 * URL 改写成 http://127.0.0.1:<port>，而是**原地**调用引擎：
 *
 *   1. DoH 取 ECH 配置 + 地址（引擎自己不查 DoH，只接受 echConfig / connectIp）
 *   2. Cookie 全交 CookieManager（C++ 侧零 cookie 代码）：
 *      请求从这里读 Cookie，响应里的 Set-Cookie 写回这里
 *   3. EchHttpNative.request() 在同一进程内完成 TLS + ECH
 *   4. 包装成 WebResourceResponse 交回 WebView
 *
 * 这样一整类问题随之消失：没有端口、没有「代理没起来」、没有「配置没生效」；
 * 而且 cookie 落在 CookieManager（本身持久），登录态天然跨进程存活。
 *
 * 失败语义：受保护域一律 fail-closed（502），绝不放行明文 SNI；
 * 非保护域如实交回 WebView，避免把无关故障归因给 ECH。
 */
object CoWebViewHelper {

    /**
     * 真实安卓 Chrome 的 UA（用户从自己手机浏览器上取的），**不含 "wv" 标记**。
     *
     * 安卓 WebView 自带的 UA 形如 "Mozilla/5.0 (Linux; Android 14; ...; wv) ..."，
     * 那个 "wv" 会被 Cloudflare 判定为非浏览器请求 → 直接 403（真机实测：同一域名
     * 下 JS 侧能通、WebView 这条被 403，差别就在 UA）。
     *
     * 用移动版而不是桌面版：页面本身要按移动布局渲染，桌面 UA 会让 AO3 返回
     * 桌面版页面，在手机上没法看。
     */
    private const val AO3_UA =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36"

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val host = request.url.host ?: return null
        val method = request.method ?: "GET"
        val url = request.url.toString()

        // 本地回环仍然直接放行：没有任何东西需要经过引擎。
        if (host == "127.0.0.1" || host == "localhost") return null

        // 登录 POST 交给 JS 桥：WebView 的 POST body 在 shouldInterceptRequest 里取不到。
        if (method == "POST" && url.contains("/users/login")) {
            Diagnostics.event("webview_login_post_passthrough", mapOf("url" to url.take(80)))
            return null
        }
        // 其余非 GET：同样取不到 body，交回 WebView。
        if (method != "GET") return null

        var lastError: String = "unknown"
        repeat(2) { attempt ->
            try {
                // 1) Cookie：引擎完全不碰 cookie，统一由 CookieManager 管。
                val cookie = runCatching { CookieManager.getInstance().getCookie(url) }
                    .getOrNull().orEmpty()
                Diagnostics.event(
                    "webview_cookie_send",
                    mapOf(
                        "host" to host,
                        "hasSession" to cookie.contains("_otwarchive_session").toString(),
                        "len" to cookie.length.toString(),
                    ),
                )

                // 2) 组请求头：透传 WebView 的头，但三处必须由我们接管：
                //    - Host：交给引擎按 URL 生成；
                //    - User-Agent：安卓 WebView 自带的 UA 里带 "wv" 标记，Cloudflare
                //      会据此判定为非浏览器请求直接 403（真机实测：同域名下 JS 侧
                //      用桌面 UA 能通、WebView 这条被 403）。JS 侧 ao3Transport 那个
                //      UA 是验证过能过 CF 的，这里保持一致；
                //    - Accept-Encoding：引擎自己做解压，两边协商会打架。
                val hb = StringBuilder()
                request.requestHeaders.forEach { (k, v) ->
                    if (k.equals("Cookie", true) || k.equals("Host", true)) return@forEach
                    if (k.equals("User-Agent", true)) return@forEach
                    if (k.equals("Accept-Encoding", true)) return@forEach
                    if (k.contains('\n') || k.contains('\r')) return@forEach
                    hb.append(k).append(": ").append(v).append("\r\n")
                }
                hb.append("User-Agent: ").append(AO3_UA).append("\r\n")
                if (cookie.isNotEmpty()) hb.append("Cookie: ").append(cookie).append("\r\n")

                // 3) 引擎请求：原始 https URL（不改写），ECH 在进程内完成。
                //    EchEngineClient 内部做 DoH 选路并**逐个尝试**候选地址 ——
                //    国内到不同 CF IP 段可达性差异极大，只试第一个会时不时全挂。
                val resp = EchEngineClient.request(
                    host = host,
                    url = url,
                    method = "GET",
                    headers = hb.toString(),
                    body = null,
                    totalTimeoutMs = 30_000L,
                )

                // 4.5) 4xx 打不出原因就只能靠猜。把状态码和响应体前缀落进诊断 ——
                //      CF 的拦截理由通常就写在 body 里，真机排查全靠它。
                if (resp.status >= 400) {
                    Diagnostics.trace(
                        "webview.httpError",
                        mapOf(
                            "host" to host,
                            "path" to url.removePrefix("https://$host"),
                            "code" to resp.status.toString(),
                            "echAccepted" to resp.echAccepted.toString(),
                            "body" to String(resp.body, Charsets.UTF_8).take(300).replace("\n", " "),
                        ),
                    )
                }

                // 5) 拆响应头。Set-Cookie 不能用 map 承载（同名多值会互相覆盖），
                //    单独提出来写进 CookieManager。
                val responseHeaders = LinkedHashMap<String, String>()
                val setCookies = ArrayList<String>()
                resp.headers.split("\r\n", "\n").forEach { line ->
                    val idx = line.indexOf(':')
                    if (idx <= 0) return@forEach
                    val name = line.substring(0, idx).trim()
                    val value = line.substring(idx + 1).trim()
                    when {
                        name.equals("Set-Cookie", true) -> setCookies.add(value)
                        // 交给 WebView 自己按 body 长度算，免得长度对不上导致截断。
                        name.equals("Content-Length", true) -> Unit
                        name.equals("Transfer-Encoding", true) -> Unit
                        name.isNotEmpty() -> responseHeaders[name] = value
                    }
                }

                // 6) Set-Cookie → CookieManager。沿用旧路线的属性改写：WebView 对
                //    Secure / SameSite=None 的接受度差，不改写会直接丢 cookie。
                runCatching {
                    val cm = CookieManager.getInstance()
                    var sessionRecv = false
                    var credsRecv = false
                    for (raw in setCookies) {
                        var fixed = raw
                        fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                        fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                        fixed = fixed.replace(Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE), "; SameSite=Lax")
                        cm.setCookie(url, fixed)
                        runCatching { cm.setCookie("https://archiveofourown.org/", fixed) }
                        if (raw.contains("_otwarchive_session")) sessionRecv = true
                        if (raw.contains("user_credentials")) credsRecv = true
                    }
                    cm.flush()
                    if (sessionRecv) Diagnostics.event("webview_cookie_recv_session", mapOf("host" to host))
                    if (credsRecv) Diagnostics.event("webview_cookie_recv_creds", mapOf("host" to host))
                }.onFailure {
                    Diagnostics.event(
                        "webview_cookie_recv_err",
                        mapOf("host" to host, "err" to (it.message ?: "")),
                    )
                }

                // 7) 包装成 WebResourceResponse
                val contentType = responseHeaders.entries
                    .firstOrNull { it.key.equals("Content-Type", true) }?.value ?: "text/html"
                var mimeType = "text/html"
                var encoding = "utf-8"
                contentType.split(";").forEachIndexed { idx, part ->
                    if (idx == 0) {
                        mimeType = part.trim().ifEmpty { "text/html" }
                    } else if (part.trim().startsWith("charset=", true)) {
                        encoding = part.trim().substringAfter("=").trim()
                    }
                }

                Diagnostics.event(
                    "webview_ok",
                    mapOf(
                        "host" to host,
                        "code" to resp.status.toString(),
                        "len" to resp.body.size.toString(),
                        "ech" to resp.echAccepted.toString(),
                        "echRetries" to resp.echRetries.toString(),
                        "attempt" to (attempt + 1).toString(),
                    ),
                )

                return WebResourceResponse(
                    mimeType,
                    encoding,
                    resp.status,
                    "OK",
                    responseHeaders,
                    ByteArrayInputStream(resp.body),
                )
            } catch (e: Exception) {
                lastError = e.message ?: e.javaClass.simpleName
                Diagnostics.event(
                    "webview_fail",
                    mapOf(
                        "host" to host,
                        "attempt" to (attempt + 1).toString(),
                        "err" to lastError.take(120),
                    ),
                )
                if (attempt == 0) {
                    // 一次重试：ECH 配置轮换 / DoH 抖动用一次机会（resolver 自带 TTL 缓存）。
                    runCatching { Thread.sleep(300) }
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
