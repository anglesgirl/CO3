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
    private var running = false

    // Current public.tls-ech.dev ConfigList; its inner public_name is visible in
    // the output below. This is intentionally not loaded from DNS/TXT/cache.
    private val echB64 = "AEn+DQBFKwAgACABWIHUGj4u+PIggYXcR5JF0gYk3dCRioBW8uJq9H4mKAAIAAEAAQABAANAEnB1YmxpYy50bHMtZWNoLmRldgAA"
    private val target = "archiveofourown.org"
    private val doh = "https://cloudflare-dns.com/dns-query"

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
            text = "ECH 独立测试器\n目标：$target\n配置 public_name：public.tls-ech.dev\n\n不读取 TXT、DoH ECH 记录或旧缓存。每次测试创建全新缓存文件，完整日志可复制。"
            setTextColor(Color.rgb(25, 25, 25)); textSize = 16f
        })
        testButton = Button(this).apply {
            text = "开始独立测试"
            setOnClickListener { runProbe() }
        }
        root.addView(testButton)
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

    private fun runProbe() {
        if (running) return
        running = true; testButton.isEnabled = false
        logView.text = "正在测试……\n"
        io.execute {
            val port = ServerSocket(0).use { it.localPort }
            val cache = File(cacheDir, "ech-probe-${System.currentTimeMillis()}.json")
            try {
                Echproxy.stop()
                Echproxy.start("127.0.0.1:$port", target, echB64, doh, "", cache.absolutePath, false)
                val url = java.net.URL("http://127.0.0.1:$port/works")
                val c = url.openConnection() as java.net.HttpURLConnection
                c.connectTimeout = 30000; c.readTimeout = 30000
                c.requestMethod = "GET"
                val code = c.responseCode
                val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
                val status = Echproxy.lastStatus()
                val outcome = if (status.contains("ECHAccepted=true") && code == 200) "\n\nRESULT: SUCCESS — ECHAccepted=true + HTTP 200" else "\n\nRESULT: NOT CONFIRMED"
                showLog("Standalone ECH probe\nTarget: $target\nBundled ECH public_name: public.tls-ech.dev\nConfig source: hard-coded test ConfigList (cache-bypass)\nHTTP: $code; body bytes: ${body.length}\n\n$status$outcome")
            } catch (t: Throwable) {
                showLog("Standalone ECH probe\nTarget: $target\nBundled ECH public_name: public.tls-ech.dev\nConfig source: hard-coded test ConfigList (cache-bypass)\n\nERROR: ${t.message}\n\n${runCatching { Echproxy.lastStatus() }.getOrDefault("status unavailable")}")
            } finally {
                runCatching { Echproxy.stop() }; cache.delete()
                runOnUiThread { running = false; testButton.isEnabled = true }
            }
        }
    }
    private fun showLog(s: String) = runOnUiThread { logView.text = s }
}
