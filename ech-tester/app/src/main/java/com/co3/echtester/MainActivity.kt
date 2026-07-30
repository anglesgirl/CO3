package com.co3.echtester

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import echproxy.Echproxy
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.Executors

/**
 * Standalone, cache-free ECH probe for a single target/config pair.
 * It uses a deliberately fresh cache location on every run so the output shows
 * whether the bundled ConfigList was accepted, rejected/retried, or failed.
 */
class MainActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var logView: TextView
    private lateinit var testButton: Button
    private lateinit var ao3Button: Button
    private var running = false

    private val target = "archiveofourown.org"
    // jsdelivr.com itself publishes the ECH record used by this experiment.
    // Do not substitute cdn.jsdelivr.net: it is a different hostname/CDN path.
    private val configHost = "jsdelivr.com"
    private val doh = "https://cloudflare-dns.com/dns-query"
    private var sharedConfigB64: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "ECH Tester"
        val pad = (20 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.WHITE)
        }
        root.addView(TextView(this).apply {
            text = "ECH 独立测试器\n先从 $configHost 获取 HTTPS ECH 配置，再严格测试。\n\n不接受 server retry_configs。每次测试创建全新缓存文件，完整日志可复制。"
            setTextColor(Color.rgb(25, 25, 25)); textSize = 16f
        })
        root.addView(TextView(this).apply {
            text = "第一步测试 jsDelivr 自己发布的原始配置；第二步原样复用同一份配置测试 AO3。工具不伪造或修改 public_name。"
            setTextColor(Color.rgb(90, 90, 90)); textSize = 13f
        })
        testButton = Button(this).apply {
            text = "获取 jsDelivr 配置并测试 jsDelivr"
            setOnClickListener { runProbe(configHost) }
        }
        root.addView(testButton)
        ao3Button = Button(this).apply {
            text = "复用同一配置测试 AO3"
            isEnabled = false
            setOnClickListener { runProbe(target) }
        }
        root.addView(ao3Button)
        root.addView(Button(this).apply {
            text = "复制完整日志"
            setOnClickListener {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("ECH test log", logView.text))
                Toast.makeText(this@MainActivity, "日志已复制", Toast.LENGTH_SHORT).show()
            }
        })
        logView = TextView(this).apply {
            text = "尚未开始。"
            setTextColor(Color.rgb(20, 20, 20)); textSize = 14f
            setTextIsSelectable(true)
            setPadding(0, pad, 0, 0)
        }
        root.addView(ScrollView(this).apply { addView(logView) }, LinearLayout.LayoutParams(-1, 0, 1f))
        root.gravity = Gravity.CENTER_HORIZONTAL
        setContentView(root)
    }

    private fun runProbe(testTarget: String) {
        if (running) return
        running = true; testButton.isEnabled = false; ao3Button.isEnabled = false
        logView.text = "正在测试……\n"
        io.execute {
            val port = ServerSocket(0).use { it.localPort }
            val cache = File(cacheDir, "ech-probe-${System.currentTimeMillis()}.json")
            try {
                val configB64 = if (testTarget == configHost && sharedConfigB64 == null) {
                    val bytes = Echproxy.fetchECHConfig(doh, configHost)
                    android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP).also { sharedConfigB64 = it }
                } else sharedConfigB64 ?: throw IllegalStateException("请先获取 jsDelivr 配置")
                Echproxy.stop()
                Echproxy.startStrict("127.0.0.1:$port", testTarget, configB64, doh, "", cache.absolutePath, false)
                val path = if (testTarget == configHost) "/" else "/works"
                val url = java.net.URL("http://127.0.0.1:$port$path")
                val c = url.openConnection() as java.net.HttpURLConnection
                c.connectTimeout = 30000; c.readTimeout = 30000
                c.requestMethod = "GET"
                val code = c.responseCode
                val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
                val status = Echproxy.lastStatus()
                val outcome = if (status.contains("ECHAccepted=true") && code == 200) "\n\nRESULT: SUCCESS — first-handshake ECH accepted" else "\n\nRESULT: REJECTED OR NOT CONFIRMED — retry_configs refused"
                showLog("Standalone ECH probe (STRICT, no retry)\nConfig obtained from HTTPS record: $configHost\nTarget: $testTarget\nShared config reused: ${testTarget != configHost}\nHTTP: $code; body bytes: ${body.length}\n\n$status$outcome")
            } catch (t: Throwable) {
                showLog("Standalone ECH probe (STRICT, no retry)\nConfig obtained from HTTPS record: $configHost\nTarget: $testTarget\n\nERROR: ${t.message}\n\n${runCatching { Echproxy.lastStatus() }.getOrDefault("status unavailable")}")
            } finally {
                runCatching { Echproxy.stop() }; cache.delete()
                runOnUiThread { running = false; testButton.isEnabled = true; ao3Button.isEnabled = sharedConfigB64 != null }
            }
        }
    }
    private fun showLog(s: String) = runOnUiThread { logView.text = s }

}
