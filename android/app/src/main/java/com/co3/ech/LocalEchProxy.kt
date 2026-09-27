package com.co3.ech

import android.util.Log
import com.co3.Diagnostics
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 进程内 ECH 本地转发服务（Android）。
 *
 * 解决的问题：WebView 原生 TLS 栈不支持 ECH —— 登录 POST / 页面请求直连
 * archiveofourown.org 时 ClientHello 的 SNI 是明文，会被 GFW 直接 RST，
 * 而 shouldInterceptRequest 又拿不到 POST body（表单拼接参数的老坑）。
 *
 * 方案（用户拍板的架构）：WebView 打开 `http://127.0.0.1:<port>/<原路径>`，
 * 明文请求只在本机回环内；本服务把请求**还原成** `https://archiveofourown.org/<原路径>`
 * 转发：
 *   - TLS/SNI/ECH 交给 ConscryptEch + EchHttp.client（SNI=archiveofourown.org，
 *     ECHConfigList 自动注入，DoH 解析由 EchDns 负责）
 *   - Host 头由 OkHttp 按目标 URL 自动生成（archiveofourown.org），不再是 127
 *   - Origin / Referer 从 http://127.0.0.1:8080 重写回 https://archiveofourown.org
 *     （AO3 有 same-origin CSRF 校验，不改必被拒）
 *   - Cookie 全权交给 OkHttp cookieJar（ReactCookieJarContainer = CookieManager，
 *     与 WebView 双向共享）；WebView 请求里带的 127 域 Cookie 头剥掉
 *   - 响应文本（HTML/CSS/JS）中 `https://archiveofourown.org` 改写回
 *     `http://127.0.0.1:<port>` —— 页面内所有链接 / 表单 action / 资源地址
 *     继续走本地转发，**路径原样不变**，浏览器原生提交、参数一个不少
 *
 * 安全边界：
 *   - 只监听 127.0.0.1（外部不可达）；目标域名固定 archiveofourown.org（ECH 保护域）
 *   - 进程内线程（非独立进程）：App 存活即服务存活，不存在"外挂进程被系统回收"
 *   - 表单提交是 WebView 原生行为（POST 到本地），不再依赖 JS 拼参数/劫持
 */
object LocalEchProxy {
    private const val TAG = "CO-LOCALPROXY"

    const val DEFAULT_PORT = 8080
    private const val MAX_BODY = 8 * 1024 * 1024
    private const val HOST = "archiveofourown.org"
    private const val WWW_HOST = "www.archiveofourown.org"

    @Volatile
    private var server: LocalHttpServer? = null

    @Volatile
    var port: Int = DEFAULT_PORT
        private set

    val baseUrl: String get() = "http://127.0.0.1:$port"

    /** 幂等启动：8080 被占则依次尝试 8081..8090。 */
    fun start(): Boolean {
        if (server != null) return true
        synchronized(this) {
            if (server != null) return true
            var lastErr: Exception? = null
            for (p in DEFAULT_PORT..(DEFAULT_PORT + 10)) {
                try {
                    val s = LocalHttpServer(p)
                    s.start()
                    server = s
                    port = p
                    Log.i(TAG, "local ECH proxy listening on 127.0.0.1:$p")
                    try {
                        Diagnostics.event("local_proxy_start", mapOf("port" to p.toString()))
                    } catch (_: Exception) {}
                    return true
                } catch (e: Exception) {
                    lastErr = e
                }
            }
            Log.e(TAG, "failed to bind 127.0.0.1:$DEFAULT_PORT..: ${lastErr?.message}")
            return false
        }
    }

    fun stop() {
        server?.stop()
        server = null
    }

    /**
     * 把 AO3 的 https URL 改写为本地转发地址（**路径原样**，不加任何参数）。
     * 非 AO3 / 已是本地地址 → 原样返回。
     */
    fun rewriteWebUrl(url: String): String {
        if (url.startsWith("https://$HOST")) return baseUrl + url.substringAfter(HOST)
        if (url.startsWith("https://$WWW_HOST")) return baseUrl + url.substringAfter(WWW_HOST)
        return url
    }

    /** 文本内容里 AO3 绝对链接 → 本地地址（HTML/CSS/JS 响应体改写）。 */
    private fun rewriteText(body: String): String =
        body.replace("https://$HOST", baseUrl).replace("https://$WWW_HOST", baseUrl)

    /** 从 WebView 来的 Origin/Referer 是本地地址时重写回 AO3。 */
    private fun rewriteLocalHeader(value: String): String {
        val v = value.trim()
        return if (v.startsWith("http://127.0.0.1") || v.startsWith("http://localhost"))
            v.replaceFirst(Regex("http://127\\.0\\.0\\.1:\\d+"), "https://$HOST")
                .replaceFirst(Regex("http://localhost:\\d+"), "https://$HOST")
        else v
    }

    private class LocalHttpServer(private val bindPort: Int) {
        private var socket: ServerSocket? = null
        @Volatile
        private var running = false
        private val threads = CopyOnWriteArrayList<Thread>()

        fun start() {
            socket = ServerSocket(bindPort, 50, InetAddress.getByName("127.0.0.1"))
            running = true
            val t = Thread { acceptLoop() }
            t.name = "co-local-proxy-$bindPort"
            t.isDaemon = true
            t.start()
            threads.add(t)
        }

        fun stop() {
            running = false
            try { socket?.close() } catch (_: Exception) {}
        }

        private fun acceptLoop() {
            while (running) {
                try {
                    val client = socket?.accept() ?: break
                    val h = Thread { handle(client) }
                    h.name = "co-proxy-conn"
                    h.isDaemon = true
                    h.start()
                    threads.add(h)
                } catch (e: Exception) {
                    if (running) Log.w(TAG, "accept err: ${e.message}")
                }
            }
        }

        private fun handle(client: Socket) {
            try {
                client.soTimeout = 30_000
                val input = client.getInputStream()
                val output = client.getOutputStream()

                // 请求行：GET /works/123?x=1 HTTP/1.1
                val line = readLine(input) ?: return
                val parts = line.split(" ")
                if (parts.size < 3) return
                val method = parts[0].uppercase()
                val uri = parts[1]
                if (!uri.startsWith("/")) return

                // 请求头（小写 key）
                val headers = LinkedHashMap<String, String>()
                while (true) {
                    val h = readLine(input) ?: break
                    if (h.isEmpty()) break
                    val idx = h.indexOf(':')
                    if (idx > 0) {
                        headers[h.substring(0, idx).trim().lowercase()] = h.substring(idx + 1).trim()
                    }
                }

                // body（POST 表单：Content-Length 原样读取，一个字节都不拼）
                var body = ByteArray(0)
                val cl = headers["content-length"]?.toIntOrNull()
                if (cl != null && cl > 0) {
                    if (cl > MAX_BODY) {
                        writeError(output, 413, "body too large")
                        return
                    }
                    body = ByteArray(cl)
                    var off = 0
                    while (off < cl) {
                        val n = input.read(body, off, cl - off)
                        if (n < 0) break
                        off += n
                    }
                }

                forward(method, uri, headers, body, output)
            } catch (e: Exception) {
                Log.w(TAG, "conn err: ${e.message}")
            } finally {
                try { client.close() } catch (_: Exception) {}
            }
        }

        private fun forward(
            method: String,
            uri: String,
            headers: Map<String, String>,
            body: ByteArray,
            output: OutputStream,
        ) {
            try {
                // 目标固定为 ECH 保护域；路径 + query 原样（uri 含 query）
                val targetUrl = "https://$HOST$uri"
                val reqBuilder = Request.Builder().url(targetUrl)

                val contentType = headers["content-type"]
                    ?: "application/x-www-form-urlencoded"
                val mediaType = runCatching { contentType.toMediaType() }.getOrNull()
                val req = when (method) {
                    "GET" -> reqBuilder.get()
                    "POST" -> reqBuilder.post(body.toRequestBody(mediaType ?: "application/x-www-form-urlencoded".toMediaType()))
                    "HEAD" -> reqBuilder.head()
                    "PUT" -> reqBuilder.put(body.toRequestBody(mediaType ?: "application/octet-stream".toMediaType()))
                    "DELETE" -> reqBuilder.delete(body.toRequestBody(mediaType ?: "application/octet-stream".toMediaType()))
                    else -> {
                        writeError(output, 405, "method not allowed")
                        return
                    }
                }

                // 请求头：剥掉本地/传输层专用头；Origin/Referer 从 127 还原成 AO3
                for ((k, v) in headers) {
                    when (k) {
                        "host", "content-length", "accept-encoding", "connection",
                        "transfer-encoding", "cookie", "proxy-connection" -> {
                            // Host/Content-Length 由 OkHttp 按目标 URL 生成；
                            // Accept-Encoding 由 OkHttp 管理（避免响应带回 Content-Encoding 混淆）；
                            // Cookie 由 cookieJar（CookieManager）统一注入，剥掉 127 域 cookie
                        }
                        "origin" -> req.addHeader("Origin", rewriteLocalHeader(v))
                        "referer" -> req.addHeader("Referer", rewriteLocalHeader(v))
                        else -> req.addHeader(k, v)
                    }
                }

                EchHttp.client.newCall(req.build()).execute().use { resp ->
                    val statusCode = resp.code
                    val statusText = resp.message.ifEmpty { "OK" }
                    val mime = resp.header("Content-Type") ?: "text/html"
                    val raw = resp.body?.bytes() ?: ByteArray(0)

                    // 文本响应改写 AO3 绝对链接 → 本地；二进制（图片等）原样
                    val isText = mime.contains("text/") || mime.contains("javascript") || mime.contains("json")
                    val outBody = if (isText) {
                        rewriteText(String(raw, StandardCharsets.UTF_8)).toByteArray(StandardCharsets.UTF_8)
                    } else raw

                    val sb = StringBuilder()
                    sb.append("HTTP/1.1 ").append(statusCode).append(' ').append(statusText).append("\r\n")
                    sb.append("Content-Type: ").append(mime).append("\r\n")
                    sb.append("Content-Length: ").append(outBody.size).append("\r\n")
                    sb.append("Connection: close\r\n")
                    // 302 的 Location 也改写，跳转继续走本地
                    val loc = resp.header("Location")
                    if (loc != null) sb.append("Location: ").append(rewriteWebUrl(loc)).append("\r\n")
                    // 业务头透传；Set-Cookie 不给 WebView（cookie 在 OkHttp cookieJar 统一管理），
                    // 传输层/压缩/安全头一律不转发
                    for (i in 0 until resp.headers.size) {
                        val name = resp.headers.name(i)
                        val value = resp.headers.value(i)
                        when (name.lowercase()) {
                            "content-type", "content-length", "location", "set-cookie",
                            "transfer-encoding", "connection", "content-encoding", "date",
                            "server", "strict-transport-security" -> {}
                            else -> sb.append(name).append(": ").append(value).append("\r\n")
                        }
                    }
                    sb.append("\r\n")
                    output.write(sb.toString().toByteArray(StandardCharsets.ISO_8859_1))
                    output.write(outBody)
                    output.flush()
                }
            } catch (e: Exception) {
                Log.w(TAG, "forward err: ${e.message}")
                try { writeError(output, 502, "forward failed") } catch (_: Exception) {}
            }
        }

        /** 逐字节读一行（必须用 InputStream 手读，不能用 BufferedReader —— 会预读 body）。 */
        private fun readLine(input: InputStream): String? {
            val sb = StringBuilder()
            var c = input.read()
            if (c < 0) return null
            while (c >= 0) {
                if (c == '\n'.code) {
                    if (sb.isNotEmpty() && sb[sb.length - 1] == '\r') sb.deleteCharAt(sb.length - 1)
                    return sb.toString()
                }
                sb.append(c.toChar())
                c = input.read()
            }
            return if (sb.isEmpty()) null else sb.toString()
        }

        private fun writeError(output: OutputStream, code: Int, msg: String) {
            val body = "<html><body><h3>$code $msg</h3></body></html>".toByteArray(StandardCharsets.UTF_8)
            val head = "HTTP/1.1 $code $msg\r\n" +
                "Content-Type: text/html; charset=utf-8\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n"
            output.write(head.toByteArray(StandardCharsets.ISO_8859_1))
            output.write(body)
            output.flush()
        }
    }
}
