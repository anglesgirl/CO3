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
        return ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)
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
                    val worker = Thread { runCatching { uploadBlocking("app_crash", fields) } }
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
