package com.co3

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
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var initialized = false

    fun initialize() {
        if (initialized) return
        initialized = true
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
