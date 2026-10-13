package com.co3.ech

import android.content.Context
import android.util.Log
import kotlinx.coroutines.*
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import javax.net.ssl.SSLSocketFactory

/**
 * Cloudflare 可用 IP 扫描器（简化版）。
 *
 * 背景：Cloudflare DoH 在国内被封（2026-10-13 起移动大面积封禁），不再依赖
 * 内置 DoH 做通用 DNS 解析。改为：
 * 1. 首次启动时扫描一批可用 CF IP，存下来
 * 2. 每次连接时随机取一个用
 * 3. ECH 配置只从 cloudflare-ech.com 经国内 DoH（纯 IP）拉取，缓存 1 小时
 *
 * 扫描逻辑参考第三方扫描器（baipiao.eu.org IP 库）：
 * - 下载 CF IPv4 段列表
 * - 每段抽样测几个 IP 的 443 端口连通性 + 延迟
 * - 保留延迟达标的 IP
 */
object CfIpScanner {
    private const val TAG = "CO3-CfIpScanner"
    private const val PREFS = "co3_cf_ips"
    private const val KEY_IPS = "scanned_ips"
    private const val KEY_SCAN_TIME = "scan_time"

    /** IP 段数据源 */
    private const val IP_LIST_URL = "https://www.baipiao.eu.org/cloudflare/ips-v4"

    /** 单个 IP 测试超时（毫秒） */
    private const val CONNECT_TIMEOUT = 3000

    /** 延迟上限（毫秒），超过的不保留 */
    private const val MAX_LATENCY = 800

    /** 每个 /24 段抽样测试的 IP 数量 */
    private const val SAMPLE_PER_RANGE = 3

    /** 目标保留的可用 IP 数量 */
    private const val TARGET_COUNT = 20

    data class ScanResult(
        val ip: String,
        val latencyMs: Long,
    )

    /**
     * 扫描可用 IP。耗时操作，必须在后台线程调用。
     * @param onProgress 进度回调 (已测试数, 总数)
     * @return 可用 IP 列表（按延迟排序）
     */
    suspend fun scan(onProgress: ((tested: Int, total: Int) -> Unit)? = null): List<ScanResult> =
        withContext(Dispatchers.IO) {
            val ranges = fetchIpRanges()
            if (ranges.isEmpty()) {
                Log.w(TAG, "IP 段列表下载失败")
                return@withContext emptyList()
            }

            // 每段抽样，生成待测 IP 列表
            val candidates = ranges.flatMap { sampleIps(it) }.shuffled()
            Log.i(TAG, "待测 IP 数: ${candidates.size}，来自 ${ranges.size} 个段")

            val results = mutableListOf<ScanResult>()
            var tested = 0

            // 并发测试，每批 50 个
            candidates.chunked(50).forEach { batch ->
                val batchResults = batch.map { ip ->
                    async { testIp(ip) }
                }.awaitAll().filterNotNull()
                results.addAll(batchResults)
                tested += batch.size
                onProgress?.invoke(tested, candidates.size)

                // 够了就停，不用全测完
                if (results.size >= TARGET_COUNT * 2) return@forEach
            }

            results.sortedBy { it.latencyMs }.take(TARGET_COUNT).also {
                Log.i(TAG, "扫描完成，可用 IP: ${it.size}")
            }
        }

    /**
     * 扫描并保存结果。供首次启动调用。
     */
    suspend fun scanAndSave(context: Context, onProgress: ((Int, Int) -> Unit)? = null): List<String> {
        val results = scan(onProgress)
        if (results.isNotEmpty()) {
            saveIps(context, results.map { it.ip })
        }
        return results.map { it.ip }
    }

    /** 读取已保存的 IP 列表 */
    fun loadIps(context: Context): List<String> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_IPS, "") ?: ""
        return raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    }

    /** 随机取一个可用 IP，没有则返回 null */
    fun pickRandomIp(context: Context): String? {
        val ips = loadIps(context)
        return if (ips.isEmpty()) null else ips.random()
    }

    /** 上次扫描时间（毫秒时间戳），0 表示没扫过 */
    fun lastScanTime(context: Context): Long {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getLong(KEY_SCAN_TIME, 0)
    }

    private fun saveIps(context: Context, ips: List<String>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_IPS, ips.joinToString(","))
            .putLong(KEY_SCAN_TIME, System.currentTimeMillis())
            .apply()
        Log.i(TAG, "已保存 ${ips.size} 个 IP")
    }

    /** 下载 CF IPv4 段列表 */
    private fun fetchIpRanges(): List<String> {
        return try {
            val conn = URL(IP_LIST_URL).openConnection().apply {
                connectTimeout = 10000
                readTimeout = 15000
            }
            conn.getInputStream().bufferedReader().readLines()
                .map { it.trim() }
                .filter { it.isNotEmpty() && it.contains('/') }
        } catch (e: Exception) {
            Log.w(TAG, "下载 IP 段失败: ${e.message}")
            emptyList()
        }
    }

    /** 从 CIDR 段中抽样几个 IP（跳过 .0 和 .255） */
    private fun sampleIps(cidr: String): List<String> {
        return try {
            val parts = cidr.split('/')
            val base = parts[0].split('.').map { it.toInt() }
            val prefix = parts[1].toInt()
            if (prefix != 24) return emptyList() // 简化版只处理 /24

            // 每段随机抽 SAMPLE_PER_RANGE 个（1-254）
            (1..254).shuffled().take(SAMPLE_PER_RANGE).map {
                "${base[0]}.${base[1]}.${base[2]}.$it"
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    /** 测试单个 IP：TCP 443 连通 + TLS 握手计时 */
    private fun testIp(ip: String): ScanResult? {
        val start = System.currentTimeMillis()
        return try {
            // 先 TCP 连通性
            Socket().use { sock ->
                sock.connect(InetSocketAddress(ip, 443), CONNECT_TIMEOUT)
            }
            // 再 TLS 握手（验证真是 CF 的 443，不是黑洞）
            val sslSock = SSLSocketFactory.getDefault()
                .createSocket(ip, 443) as javax.net.ssl.SSLSocket
            sslSock.use {
                it.soTimeout = CONNECT_TIMEOUT
                it.startHandshake()
            }
            val latency = System.currentTimeMillis() - start
            if (latency <= MAX_LATENCY) ScanResult(ip, latency) else null
        } catch (e: Exception) {
            null
        }
    }
}
