package com.co3.ech

import android.util.Log
import com.co3.Diagnostics
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 引擎请求的统一入口：Conscrypt ECH（TCP + TLS 1.3 + ECH），单路直达。
 *
 * 2026-10-02 重写：删掉 H3 首选 / H1.1 回退的双引擎结构。之前双引擎是为"统一双端"
 * 层层加码的结果；现在接受平台分治（Android = Conscrypt+OkHttp，iOS 保持 Go 代理），
 * 单路 TCP+ECH 已被 2026-09 的 Conscrypt 时代验证可用（登录都修好了）。
 *
 * 契约（调用方：EchHttpModule / CoWebViewHelper / EchEngineInterceptor 都依赖）：
 *   - 阻塞调用，只能在后台线程调
 *   - **不跟随重定向**：3xx 原样返回，Location 由调用方手动处理
 *     （登录流程要读 302 的 Location + Set-Cookie）
 *   - 5xx 原样返回（由调用方判定是否重试），I/O 失败抛 IOException
 *   - fail-closed：ECH/DoH 失败抛异常，绝不降级明文
 */
object EchEngineClient {

    private const val TAG = "CO-ECHHTTP"

    /** 一次请求的完整结果。 */
    class Response(
        @JvmField val status: Int,
        @JvmField val headers: String,
        @JvmField val body: ByteArray,
        @JvmField val echAccepted: Boolean,
        @JvmField val echRetries: Int,
    )

    /** 响应体上限：AO3 页面都是 KB 级，32MB 是防异常兜底。 */
    private const val MAX_BODY_BYTES = 32L * 1024 * 1024

    fun request(
        host: String,
        url: String,
        method: String = "GET",
        headers: String = "",
        body: ByteArray? = null,
        totalTimeoutMs: Long = 30_000L,
    ): Response {
        val tStart = System.currentTimeMillis()

        if (!ConscryptEch.install()) {
            throw IOException("Conscrypt 初始化失败 —— fail-closed 不放行明文")
        }

        val reqBuilder = Request.Builder().url(url)
        var contentType: String? = null
        headers.split("\r\n", "\n").forEach { line ->
            val idx = line.indexOf(':')
            if (idx <= 0) return@forEach
            val name = line.substring(0, idx).trim()
            val value = line.substring(idx + 1).trim()
            if (name.isEmpty()) return@forEach
            if (name.equals("Content-Type", ignoreCase = true)) contentType = value
            // Content-Length 由 OkHttp 自己算，不手动带（免得对不上被截断）
            if (name.equals("Content-Length", ignoreCase = true)) return@forEach
            reqBuilder.header(name, value)
        }

        val m = method.ifBlank { "GET" }.uppercase()
        when (m) {
            "GET" -> reqBuilder.get()
            "HEAD" -> reqBuilder.head()
            else -> {
                val rb = (body ?: ByteArray(0))
                    .toRequestBody(contentType?.toMediaTypeOrNull())
                reqBuilder.method(m, rb)
            }
        }

        val call = EchHttp.client.newCall(reqBuilder.build())
        // 整次请求的总预算（含 DoH + 握手 + 读 body）
        call.timeout().deadline(totalTimeoutMs.coerceAtLeast(1_000L), TimeUnit.MILLISECONDS)

        try {
            call.execute().use { resp ->
                val status = resp.code
                val headerStr = buildString {
                    // 逐个追加：同名多值（如 Set-Cookie）全部保留，不合并
                    for (i in 0 until resp.headers.size) {
                        append(resp.headers.name(i)).append(": ")
                            .append(resp.headers.value(i)).append("\r\n")
                    }
                }
                val respBody = readBounded(resp.body?.byteStream(), MAX_BODY_BYTES)
                val totalMs = System.currentTimeMillis() - tStart
                Diagnostics.event(
                    "engine_ok",
                    mapOf(
                        "host" to host,
                        "url" to url.take(100),
                        "method" to m,
                        "echAccepted" to "true",
                        "status" to status.toString(),
                        "bodyBytes" to respBody.size.toString(),
                        "totalMs" to totalMs.toString(),
                    ),
                )
                if (totalMs > 10_000) {
                    Log.w(TAG, "$m $url 慢请求 ${totalMs}ms（status=$status）")
                }
                return Response(status, headerStr, respBody, true, 0)
            }
        } catch (e: IOException) {
            Diagnostics.event(
                "engine_fail",
                mapOf(
                    "host" to host,
                    "url" to url.take(100),
                    "method" to m,
                    "err" to "${e.javaClass.simpleName}: ${e.message?.take(120)}",
                    "totalMs" to (System.currentTimeMillis() - tStart).toString(),
                ),
            )
            throw e
        }
    }

    private fun readBounded(
        input: java.io.InputStream?,
        maxBytes: Long,
    ): ByteArray {
        if (input == null) return ByteArray(0)
        val out = ByteArrayOutputStream()
        input.use { ins ->
            val buf = ByteArray(8192)
            var total = 0L
            while (true) {
                val n = ins.read(buf)
                if (n < 0) break
                total += n
                if (total > maxBytes) throw IOException("响应体超过 ${maxBytes / 1024 / 1024}MB 上限")
                out.write(buf, 0, n)
            }
        }
        return out.toByteArray()
    }
}
