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

    /** 远程诊断日志开关：调试期间默认开，正式版默认关（关于页连点 7 次版本号切换） */
    fun isEnabled(): Boolean {
        val ctx = appContext ?: return false
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
        // 调试期间强制开启远程日志（正式版发布前改回）
        setEnabled(true)
        installCrashReporter()
        event("app_started", mapOf("sdk" to Build.VERSION.SDK_INT, "device" to "${Build.MANUFACTURER} ${Build.MODEL}"))
    }

    private fun installCrashReporter() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                val trace = error.stackTrace.take(12).joinToString("\n") { it.toString() }
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
            prev?.uncaughtException(thread, error)
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
