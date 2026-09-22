package com.co3

import android.content.Context
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

object Diagnostics {
    private const val endpoint = "https://log.anglesgirl.eu.org/v1/events"
    private const val appId = "co3"
    private const val PREF_NAME = "co3_diagnostics"
    private const val KEY_ENABLED = "enabled"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var initialized = false
    @Volatile private var appContext: Context? = null

    /**
     * 远程诊断日志开关。
     * **默认关**（正式版策略：不主动上传任何用户数据；关于页连点 7 次版本号可手动开启）。
     * 调试期需要看日志时，由调用方显式 setEnabled(true)。
     */
    fun isEnabled(): Boolean {
        val ctx = appContext ?: return false
        // 默认**开启**：用户要求"测试时不用手动发日志"，而 ECH/H3/原生状态这些关键事件只有原生侧能报。
        // 接收端会自动剔除 token/cookie/password 等敏感键，用户仍可在设置里关掉。
        return ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true)
    }

    fun setEnabled(enabled: Boolean) {
        val ctx = appContext ?: return
        ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    fun initialize(context: Context) {
        if (initialized) return
        initialized = true
        appContext = context.applicationContext
        // ⚠️ 这里**不再强制开启**远程上报。
        // 正式版策略：默认关（isEnabled 的默认值为 false），用户可在"关于"页连点 7 次版本号开启。
        // 之前这里写着 setEnabled(true)，等于无论用户怎么选都会上传 —— 那是调试期的临时行为。
        installCrashReporter()
        event("app_started", mapOf("sdk" to Build.VERSION.SDK_INT, "device" to "${Build.MANUFACTURER} ${Build.MODEL}"))
    }

    private fun installCrashReporter() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                val trace = error.stackTrace.take(12).joinToString("\n") { it.toString() }
                // ① 本地崩溃日志**始终保留**（无 GMS/无网络也能事后排查，用户可自行查看）
                writeLocalCrash(thread.name, error.javaClass.name, error.message ?: "", trace)
                // ② 远程上报**受开关控制** —— 原来这里直接调 uploadBlocking，
                //    绕过了 isEnabled()，"默认关"对崩溃上报形同虚设。
                if (isEnabled()) {
                    val fields = mapOf(
                        "thread" to thread.name,
                        "error_type" to error.javaClass.name,
                        "message" to (error.message ?: "unknown"),
                        "stack" to trace,
                        "sdk" to Build.VERSION.SDK_INT.toString()
                    )
                    val worker = Thread {
                        runCatching {
                            // 先冲全流程缓冲 —— 崩溃前那几步（DoH/ECH/TLS）往往就是病因，
                            // 这条 HttpURLConnection 通道不经 ECH，ECH 挂了也能送出去。
                            runCatching { flushBlocking() }
                            uploadBlocking("app_crash", fields)
                        }
                    }
                    worker.isDaemon = true
                    worker.start()
                    worker.join(4000L)
                }
            }
            prev?.uncaughtException(thread, error)
        }
    }

    /** 把崩溃写入应用私有目录（本地保留，不上传）。 */
    private fun writeLocalCrash(threadName: String, type: String, message: String, trace: String) {
        runCatching {
            val ctx = appContext ?: return
            val f = java.io.File(ctx.filesDir, "crash.log")
            // 只保留最近若干次，避免无限增长
            if (f.exists() && f.length() > 64 * 1024) f.delete()
            f.appendText(
                buildString {
                    append(Instant.now().toString()); append(" [").append(threadName).append("]\n")
                    append(type); append(": "); append(message); append('\n')
                    append(trace); append("\n\n")
                }
            )
        }
    }

    fun event(name: String, fields: Map<String, Any?> = emptyMap()) {
        // 远程诊断开关：默认关（关于页连点 7 次版本号开启），避免大量无关日志上传
        if (!isEnabled()) return
        val safe = fields.mapNotNull { (k, v) -> if (v == null) null else k to v.toString().take(512) }.toMap()
        scope.launch { runCatching { upload(name, safe) } }
    }

    // ==================== 全流程追踪（trace） ====================
    //
    // 为什么不能沿用 event() 的「一条事件发一次请求」：
    //   1. 启动时几十个事件 = 几十个 HTTP 请求，每个 5s 超时、彼此排队；
    //   2. **没有本地留存** —— App 崩溃/被杀时，恰恰最需要的那批事件全丢；
    //   3. 并发 upload 无顺序保证，时序错乱后无法还原链路。
    //
    // 现在：事件同步写入有序缓冲（极快、不阻塞调用方），再按批 flush；
    // 崩溃时同步 flush 一次。上报走 HttpURLConnection（系统 TLS），
    // **刻意不经 ECH** —— ECH 坏掉时这条路仍然通，正是它的价值所在。
    private val bufferLock = Any()
    private val buffer = ArrayList<String>(640)
    private const val BUFFER_MAX = 800
    @Volatile private var lastFlushAt = 0L
    private const val FLUSH_INTERVAL_MS = 4000L
    private const val FLUSH_MIN_EVENTS = 20
    private const val CHUNK_CHARS = 6000   // 单条事件体的字符预算

    /**
     * 记录一步全流程追踪。
     *
     * step 命名约定「阶段.动作」，便于事后按前缀过滤还原链路：
     *   boot.*  启动与初始化      net.*   DoH 解析
     *   ech.*   ECH 配置获取      tls.*   TLS 连接与 ECH 注入
     *   http.*  请求与响应        h3.*    HTTP/3 尝试
     *   wv.*    WebView 拦截
     *
     * 例：net.doh.begin / net.doh.ok / ech.config.miss / tls.ech.inject.fail
     */
    fun trace(step: String, fields: Map<String, Any?> = emptyMap()) {
        if (!isEnabled()) return
        val line = buildString {
            append(Instant.now().toString()); append(' '); append(step)
            if (fields.isNotEmpty()) {
                append(' ')
                append(
                    fields.entries.joinToString(" ") { (k, v) ->
                        "$k=${(v?.toString() ?: "null").replace('\n', ' ').take(200)}"
                    }
                )
            }
        }
        android.util.Log.i("CO-TRACE", line)
        synchronized(bufferLock) {
            if (buffer.size >= BUFFER_MAX) buffer.removeAt(0) // 环形：牺牲最旧的
            buffer.add(line)
        }
        maybeFlush()
    }

    private fun maybeFlush() {
        val now = System.currentTimeMillis()
        val size = synchronized(bufferLock) { buffer.size }
        if (size < FLUSH_MIN_EVENTS && now - lastFlushAt < FLUSH_INTERVAL_MS) return
        flushAsync()
    }

    fun flushAsync() {
        if (!isEnabled()) return
        scope.launch { runCatching { flushBlocking() } }
    }

    /**
     * 把缓冲整批发出去。切成若干块（避免单请求体过大），每块一条 native_trace 事件。
     * 失败则把未发出去的部分放回缓冲（下次重试），但不超过上限，防止无限堆积。
     */
    fun flushBlocking() {
        val batch: List<String>
        synchronized(bufferLock) {
            if (buffer.isEmpty()) return
            batch = ArrayList(buffer)
            buffer.clear()
            lastFlushAt = System.currentTimeMillis()
        }
        val chunks = chunkLines(batch)
        var sentUpTo = 0
        try {
            chunks.forEachIndexed { i, c ->
                uploadBatch(batch.size, i, chunks.size, c)
                sentUpTo = i + 1
            }
        } catch (t: Throwable) {
            // 把没成功的部分放回，等下次 flush 重试
            val unsent = ArrayList<String>()
            for (i in sentUpTo until chunks.size) unsent.addAll(chunkLines(splitChunk(chunks[i])))
            if (unsent.isNotEmpty()) {
                synchronized(bufferLock) {
                    val room = BUFFER_MAX - buffer.size
                    if (room > 0) buffer.addAll(0, unsent.takeLast(room))
                }
            }
            android.util.Log.w("CO-TRACE", "flush failed: ${t.message}")
        }
    }

    private fun chunkLines(lines: List<String>): List<String> {
        val out = ArrayList<String>()
        val sb = StringBuilder()
        for (l in lines) {
            if (sb.isNotEmpty() && sb.length + l.length + 1 > CHUNK_CHARS) {
                out.add(sb.toString()); sb.setLength(0)
            }
            if (sb.isNotEmpty()) sb.append('\n')
            sb.append(l)
        }
        if (sb.isNotEmpty()) out.add(sb.toString())
        return out
    }

    private fun splitChunk(chunk: String): List<String> = chunk.split('\n')

    private fun uploadBatch(total: Int, index: Int, chunks: Int, lines: String) {
        val body = JSONObject().apply {
            put("app", appId)
            put("event", "native_trace")
            put("timestamp", Instant.now().toString())
            put("fields", JSONObject().apply {
                put("total", total.toString())
                put("chunk", "${index + 1}/$chunks")
                put("lines", lines)
            })
        }.toString().toByteArray(Charsets.UTF_8)
        postBody(body)
    }

    private fun postBody(body: ByteArray, timeoutMs: Int = 6000) {
        val c = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; connectTimeout = timeoutMs; readTimeout = timeoutMs; doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Content-Length", body.size.toString())
        }
        try { c.outputStream.use { it.write(body) }; c.inputStream.close() } finally { c.disconnect() }
    }

    private suspend fun upload(name: String, fields: Map<String, String>) = withContext(Dispatchers.IO) { uploadBlocking(name, fields) }

    private fun uploadBlocking(name: String, fields: Map<String, String>) {
        val body = JSONObject().apply {
            put("app", appId)
            put("event", name)
            put("timestamp", Instant.now().toString())
            put("fields", JSONObject(fields))
        }.toString().toByteArray(Charsets.UTF_8)
        val c = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; connectTimeout = 5000; readTimeout = 5000; doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Content-Length", body.size.toString())
        }
        try { c.outputStream.use { it.write(body) }; c.inputStream.close() } finally { c.disconnect() }
    }
}
