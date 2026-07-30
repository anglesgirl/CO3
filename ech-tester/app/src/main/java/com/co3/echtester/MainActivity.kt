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
import android.widget.EditText
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
    private lateinit var publicNameInput: EditText
    private var running = false

    // The test ConfigList has this original public_name. The tester can replace
    // that field for controlled experiments without reading TXT/DNS ECH/cache.
    private val bundledPublicName = "public.tls-ech.dev"
    private val publicNamePreference = "ech_tester_public_name"
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
            text = "ECH 独立测试器\n目标：$target\n\n不读取 TXT、DoH ECH 记录或旧缓存。每次测试创建全新缓存文件，完整日志可复制。"
            setTextColor(Color.rgb(25, 25, 25)); textSize = 16f
        })
        publicNameInput = EditText(this).apply {
            hint = "ECH public_name"
            setText(getPreferences(MODE_PRIVATE).getString(publicNamePreference, bundledPublicName))
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        root.addView(publicNameInput, LinearLayout.LayoutParams(-1, -2))
        root.addView(TextView(this).apply {
            text = "仅替换当前测试 ConfigList 的 public_name。它不会生成新的 ECH 密钥；填写值必须与该 ConfigList/服务器实际匹配。"
            setTextColor(Color.rgb(90, 90, 90)); textSize = 13f
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
        val publicName = publicNameInput.text.toString().trim().lowercase()
        if (!isValidPublicName(publicName)) {
            Toast.makeText(this, "请输入有效的 ASCII 域名（例如 cloudflare-ech.com）", Toast.LENGTH_LONG).show()
            return
        }
        val configuredEch = try {
            replacePublicName(echB64, bundledPublicName, publicName)
                .also { getPreferences(MODE_PRIVATE).edit().putString(publicNamePreference, publicName).apply() }
        } catch (e: IllegalArgumentException) {
            Toast.makeText(this, e.message ?: "public_name 配置无效", Toast.LENGTH_LONG).show()
            return
        }
        running = true; testButton.isEnabled = false; publicNameInput.isEnabled = false
        logView.text = "正在测试……\n"
        io.execute {
            val port = ServerSocket(0).use { it.localPort }
            val cache = File(cacheDir, "ech-probe-${System.currentTimeMillis()}.json")
            try {
                Echproxy.stop()
                Echproxy.start("127.0.0.1:$port", target, configuredEch, doh, "", cache.absolutePath, false)
                val url = java.net.URL("http://127.0.0.1:$port/works")
                val c = url.openConnection() as java.net.HttpURLConnection
                c.connectTimeout = 30000; c.readTimeout = 30000
                c.requestMethod = "GET"
                val code = c.responseCode
                val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
                val status = Echproxy.lastStatus()
                val outcome = if (status.contains("ECHAccepted=true") && code == 200) "\n\nRESULT: SUCCESS — ECHAccepted=true + HTTP 200" else "\n\nRESULT: NOT CONFIRMED"
                showLog("Standalone ECH probe\nTarget: $target\nConfigured ECH public_name: $publicName\nConfig source: hard-coded test ConfigList with public_name replacement (cache-bypass)\nHTTP: $code; body bytes: ${body.length}\n\n$status$outcome")
            } catch (t: Throwable) {
                showLog("Standalone ECH probe\nTarget: $target\nConfigured ECH public_name: $publicName\nConfig source: hard-coded test ConfigList with public_name replacement (cache-bypass)\n\nERROR: ${t.message}\n\n${runCatching { Echproxy.lastStatus() }.getOrDefault("status unavailable")}")
            } finally {
                runCatching { Echproxy.stop() }; cache.delete()
                runOnUiThread { running = false; testButton.isEnabled = true; publicNameInput.isEnabled = true }
            }
        }
    }
    private fun showLog(s: String) = runOnUiThread { logView.text = s }

    private fun isValidPublicName(value: String): Boolean =
        value.length in 1..253 && value.matches(Regex("[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?"))

    /**
     * Rewrites the encoded public_name in the bundled ECHConfigList and updates
     * its enclosing 16-bit lengths. This is intentionally limited to the one
     * known test vector rather than pretending to be a general ECHConfig editor.
     */
    private fun replacePublicName(configB64: String, from: String, to: String): String {
        val original = android.util.Base64.decode(configB64, android.util.Base64.DEFAULT)
        val old = from.encodeToByteArray()
        val replacement = to.encodeToByteArray()
        require(replacement.size in 1..255) { "public_name 长度必须为 1–255 字节" }
        val nameStart = original.indexOfSlice(old)
        require(nameStart > 0 && original.getOrNull(nameStart - 1)?.toInt() == old.size) {
            "测试 ConfigList 中未找到原始 public_name"
        }
        val delta = replacement.size - old.size
        val changed = ByteArray(original.size + delta)
        original.copyInto(changed, 0, 0, nameStart - 1)
        changed[nameStart - 1] = replacement.size.toByte()
        replacement.copyInto(changed, nameStart)
        original.copyInto(changed, nameStart + replacement.size, nameStart + old.size, original.size)
        // ECHConfigList length at offset 0; ECHConfig contents length at offset 4.
        for (offset in intArrayOf(0, 4)) {
            val length = ((original[offset].toInt() and 0xff) shl 8) or (original[offset + 1].toInt() and 0xff)
            val adjusted = length + delta
            require(adjusted in 0..0xffff) { "ECH ConfigList 长度无效" }
            changed[offset] = (adjusted ushr 8).toByte()
            changed[offset + 1] = adjusted.toByte()
        }
        return android.util.Base64.encodeToString(changed, android.util.Base64.NO_WRAP)
    }

    private fun ByteArray.indexOfSlice(needle: ByteArray): Int {
        if (needle.isEmpty() || needle.size > size) return -1
        for (i in 0..(size - needle.size)) {
            if (needle.indices.all { this[i + it] == needle[it] }) return i
        }
        return -1
    }
}
