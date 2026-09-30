package com.co3.ech

import android.webkit.CookieManager
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.IOException

/**
 * RN 网络栈的引擎拦截器：受保护域（AO3 等）的请求全部交给 ech_http 引擎。
 *
 * 与 WebView 那条路（CoWebViewHelper）是**同一套分工**：
 *   1. DoH 取 ECH 配置 + 地址（引擎自己不查 DoH）
 *   2. Cookie 交 CookieManager（引擎零 cookie 代码），请求读出、响应写回
 *   3. EchHttpNative.request() 在同进程内完成 TLS + ECH
 *   4. 结果包装回 okhttp3.Response 交给调用方（Fresco / fetch）
 *
 * 为什么不改写 URL 交给本地端口了：引擎不监听端口。改写那套（127.0.0.1:<port>）
 * 连带的问题是端口/启动时序/配置生效——在停用 Go 之后这些整体不存在。
 *
 * 失败语义：受保护域直接抛 IOException（fail-closed），绝不放行明文 SNI；
 * 非受保护域原样 `chain.proceed`。
 */
object EchEngineInterceptor {

    private const val TAG = "CO3-ECHHTTP"

    fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val host = req.url.host

        // 非保护域：不接管，按原样发出去（否则会把无关故障归因给 ECH）。
        if (!EchHosts.isProtected(host)) return chain.proceed(req)

        if (!EchHttpNative.isAvailable) {
            throw IOException("引擎不可用（libco3ech.so 未加载）—— fail-closed 不放行明文")
        }

        // Cookie：与 WebView 共用 CookieManager
        val cookie = runCatching { CookieManager.getInstance().getCookie(req.url.toString()) }
            .getOrNull().orEmpty()

        // 3) 组请求头
        val hb = StringBuilder()
        req.headers.forEach { (k, v) ->
            if (k.equals("Cookie", true) || k.equals("Host", true)) return@forEach
            // 交给引擎自己协商/解压，避免双重编码
            if (k.equals("Accept-Encoding", true)) return@forEach
            if (k.contains('\n') || k.contains('\r')) return@forEach
            hb.append(k).append(": ").append(v).append("\r\n")
        }
        if (cookie.isNotEmpty()) hb.append("Cookie: ").append(cookie).append("\r\n")

        // 4) 请求体（POST 表单等；GET 为 null）
        val reqBody: ByteArray? = req.body?.let {
            val buf = Buffer()
            it.writeTo(buf)
            buf.readByteArray()
        }

        // 5) 引擎请求（原始 https URL）。EchEngineClient 内部选路并逐个试候选地址。
        val resp = EchEngineClient.request(
            host = host,
            url = req.url.toString(),
            method = req.method,
            headers = hb.toString(),
            body = reqBody,
            totalTimeoutMs = 30_000L,
        )

        // 6) 拆响应头 + Set-Cookie 写回 CookieManager
        val builder = Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(resp.status)
            .message("OK")

        var contentType: String? = null
        resp.headers.split("\r\n", "\n").forEach { line ->
            val idx = line.indexOf(':')
            if (idx <= 0) return@forEach
            val name = line.substring(0, idx).trim()
            val value = line.substring(idx + 1).trim()
            if (name.isEmpty()) return@forEach

            when {
                name.equals("Set-Cookie", true) -> {
                    // 属性改写与 WebView 路径保持一致：WebView/OkHttp 对
                    // Secure + SameSite=None 的接受度差，不改写会丢 cookie。
                    runCatching {
                        val cm = CookieManager.getInstance()
                        var fixed = value
                        fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                        fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                        fixed = fixed.replace(
                            Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE),
                            "; SameSite=Lax",
                        )
                        cm.setCookie(req.url.toString(), fixed)
                        runCatching { cm.setCookie("https://archiveofourown.org/", fixed) }
                        cm.flush()
                    }
                }
                // 长度/编码由 OkHttp 依 body 自己算，避免与解压后长度冲突
                name.equals("Content-Length", true) -> Unit
                name.equals("Transfer-Encoding", true) -> Unit
                name.equals("Content-Encoding", true) -> Unit
                else -> {
                    if (name.equals("Content-Type", true)) contentType = value
                    runCatching { builder.addHeader(name, value) }
                }
            }
        }

        builder.body(resp.body.toResponseBody(contentType?.toMediaTypeOrNull()))
        return builder.build()
    }
}
