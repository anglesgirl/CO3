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
import java.io.IOException

class CoEchInterceptor : Interceptor {
    companion object {
        private const val TAG = "CO-ECH"
        private const val DOH_URL = "https://82sew1c85i.cloudflare-gateway.com/dns-query"
        private const val DOH_RESOLVE = "82sew1c85i.cloudflare-gateway.com:443:162.159.36.20,162.159.36.5"
    }

    /**
     * 是否属于 **ECH 保护域名**。
     *
     * 注意：这里**只判断域名归属**，不再把「Go 库是否已加载」混进来 ——
     * 之前那句 `if (!EchHttpClient.isLoaded) return false` 会让 ECH 未就绪时
     * 直接走下面的 chain.proceed(request)，也就是**明文直连**（SNI 暴露）。
     * 现在改为：保护域名一律进拦截器，由拦截器决定「能不能走 ECH」。
     */
    private fun isEchProtectedHost(host: String): Boolean {
        val h = host.lowercase()
        return h == "archiveofourown.org" || h.endsWith(".archiveofourown.org")
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val host = request.url.host
        // 非保护域名（在线翻译接口、DoH 自身等）直接放行：
        // 它们不受 ECH 保护，若一并拦截会被误判为失败。
        if (!isEchProtectedHost(host)) return chain.proceed(request)

        // 【fail-closed / 核心】保护域名 + ECH 未就绪 => **绝不发起任何网络连接**。
        // 用户要求：ECH 未成功时不要连网。既避免明文 SNI 被 GFW 看到，
        // 也避免把注定失败的请求真的发出去（无谓等待 + 徒增暴露面）。
        if (!EchHttpClient.isLoaded) {
            try {
                Diagnostics.event(
                    "ech_blocked_not_ready",
                    mapOf("host" to host, "why" to "go_lib_not_loaded"),
                )
            } catch (t: Throwable) {
                // 诊断失败不影响拦截决策
            }
            Log.w(TAG, "blocked $host: ECH not ready -> refuse to connect at all")
            throw IOException("ECH 未就绪（fail-closed）：拒绝以明文访问 $host，避免 SNI 暴露")
        }

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

        // 【登录失败的真因】RN 的 multipart body（FormData）把 Content-Type
        // （含 multipart 的 boundary）挂在 **body 对象**上，而不是 headers 里。
        // 只遍历 request.headers 会漏掉它 —— 于是 curl 发出去的 multipart
        // 没有 boundary 声明，服务端无法解析 body，AO3 直接把我们弹回登录页。
        // 实测日志：ech_req_body {method:POST, body_len:766, ctype:"-"} -> 登录失败。
        if (headers.none { it.startsWith("Content-Type:", ignoreCase = true) }) {
            val fromBody = try { request.body?.contentType()?.toString() } catch (_: Throwable) { null }
            val ctype = request.header("Content-Type") ?: fromBody
            if (!ctype.isNullOrEmpty()) headers.add("Content-Type: $ctype")
        }

        val bodyBytes: ByteArray? = request.body?.let { body ->
            val buffer = Buffer()
            body.writeTo(buffer)
            buffer.readByteArray()
        }

        // 诊断：非 GET 请求必须看到 body_len > 0，否则登录类 POST 必然失败。
        // 之前日志只记 status，无法区分"body 丢了"还是"响应被拒"，所以查不出原因。
        if (request.method != "GET") {
            Diagnostics.event(
                "ech_req_body",
                mapOf(
                    "host" to host,
                    "method" to request.method,
                    "body_len" to (bodyBytes?.size ?: 0),
                    "ctype" to (request.header("Content-Type") ?: (try { request.body?.contentType()?.toString() } catch (_: Throwable) { null }) ?: "-").take(60),
                    "url" to request.url.toString().take(70),
                ),
            )
            // 400 Bad Request 多为 multipart 成形问题/请求头缺失。
            // 记下实际发出去的头列表 + body 开头，才能判断边界符、Origin、Content-Length 等。
            // Cookie 值动辄 700+ 字符，会把其他头挤出 400 字符窗口（曾因此看不到 Origin 是否带上），
            // 故分开记：Cookie 只记名字（用于判断 cf_clearance/__cf_bm/_cfuvid 是否齐全），其余头全量。
            val sentCookieNames = headers.filter { it.startsWith("Cookie:", ignoreCase = true) }
                .flatMap { it.substringAfter(":").split(";") }
                .map { it.substringBefore("=").trim() }
                .filter { it.isNotEmpty() }
                .distinct()
            Diagnostics.event(
                "ech_req_headers",
                mapOf(
                    "host" to host,
                    "hdrs" to headers.filterNot { it.startsWith("Cookie:", ignoreCase = true) }
                        .joinToString(" | ").take(500),
                    "cookieNames" to sentCookieNames.joinToString(",").take(200),
                    "body_head" to (bodyBytes?.let { b ->
                        String(b.copyOfRange(0, minOf(b.size, 160)), Charsets.ISO_8859_1)
                            .replace("\r", "\\r").replace("\n", "\\n")
                    } ?: "-"),
                ),
            )
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

                // 只有明确 REJECTED/ECH 握手失败才按 ECH 失败处理。
                // "ECH accepted with target configuration" 表示 ECH 成功，即使 HTTP 4xx/5xx 也是业务状态，不是 ECH 失败。
                val echFailed = echStatus.contains("REJECTED", true) ||
                    echStatus.contains("ECH was not offered", true) ||
                    echStatus.contains("ech was disabled", true) ||
                    echStatus.contains("failed", true) && echStatus.contains("ech", true)
                if (echFailed) {
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
                    // 同步 Set-Cookie 到 CookieManager（OkHttp与WebView共用）
                try {
                    val cm = CookieManager.getInstance()
                    val urlStr = request.url.toString()
                    for (sc in setCookies) {
                        // 仿 Go 旧版：去 Domain/Secure/SameSite 改写，确保 WebView 能接收（尤其是 user_credentials）
                        var fixed = sc
                        // 移除 Domain 属性（让 cookie 成为 host-only，避免 domain 不匹配被拒）
                        fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                        fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                        // 统一 SameSite 为 Lax（WebView 兼容最好）
                        fixed = fixed.replace(Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE), "; SameSite=Lax")
                        cm.setCookie(urlStr, fixed)
                        // 同时用精简版再设一次到根域，确保 getCookie 能拿到
                        try { cm.setCookie("https://archiveofourown.org/", fixed) } catch(_:Exception){}
                        val isSession = sc.contains("_otwarchive_session")
                        val isCred = sc.contains("user_credentials")
                        if (isSession || isCred) {
                            Diagnostics.event("cookie_recv_session", mapOf("host" to host, "url" to urlStr.take(80), "cookie" to sc.take(140)))
                            android.util.Log.i("CO-COOKIE", "recv cookie ${if(isCred) "user_credentials" else "session"} $sc")
                        }
                    }
                    if (setCookies.isNotEmpty()) { cm.flush(); Diagnostics.event("cookie_recv", mapOf("host" to host, "count" to setCookies.size.toString(), "hasSession" to setCookies.any{it.contains("_otwarchive_session")}.toString(), "hasCred" to setCookies.any{it.contains("user_credentials")}.toString())) }
                } catch (e: Exception) { Diagnostics.event("cookie_recv_err", mapOf("host" to host, "err" to (e.message?:"")))}
                // 把非 GET 的响应正文捞出来 —— 登录 POST 返回 200 但无 Set-Cookie 时，
                // 正文才是唯一能分辨"CF 挑战页 / AO3 重渲染登录页 / 真报错"的证据。
                // 之前只在 >=400 时记录，导致 200 场景完全黑箱（sc=0 查不出原因）。
                if (statusCode >= 400 || request.method != "GET") {
                    try {
                        val text = String(bodyBytesDecoded, Charsets.UTF_8)
                        val feats = listOf(
                            "challenge-platform", "_cf_chl_opt", "Just a moment",
                            "challenges.cloudflare.com", "Turnstile", "doesn",
                            "auth_error", "Session Expired", "new_user", "Log Out",
                            "user_credentials", "flash alert",
                        ).filter { text.contains(it) }.joinToString(",")
                        val head = text.replace("\n", " ").replace("\r", " ")
                            .take(minOf(220, text.length))
                        Diagnostics.event(
                            "ech_resp_body",
                            mapOf(
                                "host" to host,
                                "method" to request.method,
                                "code" to statusCode,
                                "len" to bodyBytesDecoded.size,
                                "feats" to feats.take(180),
                                "head" to head,
                            ),
                        )
                    } catch (_: Throwable) { }
                }
                com.co3.Diagnostics.event(
                    "ech_ok",
                    mapOf(
                        "host" to host,
                        "status" to statusCode,
                        "ech" to echStatus,
                        "method" to request.method,
                        "body_len" to (bodyBytes?.size ?: 0),
                        "loc" to (responseHeaders.build()["Location"] ?: "-").take(50),
                        "sc" to setCookies.size,
                    ),
                )
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
