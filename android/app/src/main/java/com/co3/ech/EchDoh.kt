package com.co3.ech

import android.util.Log
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.dnsoverhttps.DnsOverHttps
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * DoH 层：拿目标域名的真实 IP（绕大陆 DNS 污染）+ 拿 ECHConfigList。
 *
 * - **A/AAAA 解析用 OkHttp 官方 `DnsOverHttps`**（自带 TTL 缓存、失败重试），
 *   并用 `bootstrapDnsHosts` 把 DoH 网关自己钉到 CF 边缘 IP，避免"解析 DoH 域名时又被污染"。
 * - **ECHConfigList 仍要自己查**：`DnsOverHttps` 只做 A/AAAA，而 ECH 配置在 HTTPS(65) 记录里，
 *   所以这里用同一个 bootstrap 客户端发 JSON 查询（application/dns-json）并手动解析 ech= 。
 *
 * 设计约束：所有失败都 fail-closed。拿不到 ECH 配置时上层宁可不连，
 * 绝不以明文 SNI 直连（那等于把被墙域名写在脸上）。
 */
object EchDoh {

    private const val TAG = "CO-ECH-DOH"

    /** 云端 DoH 网关（与旧 JNI 链路同一个，换传输层不改这里） */
    const val DOH_URL = "https://82sew1c85i.cloudflare-gateway.com/dns-query"
    private const val DOH_HOST = "82sew1c85i.cloudflare-gateway.com"

    /** 网关自身 pin 到 CF 边缘 IP */
    private val DOH_PIN_IPS = listOf("162.159.36.20", "162.159.36.5")

    private val bootstrapClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    /** 官方 DoH 解析器：A/AAAA + TTL 缓存；DoH 网关走 bootstrap IP，绕开污染 */
    private val dohResolver: DnsOverHttps by lazy {
        val pins = DOH_PIN_IPS.mapNotNull { runCatching { InetAddress.getByName(it) }.getOrNull() }
        DnsOverHttps.Builder()
            .client(bootstrapClient)
            .url(DOH_URL.toHttpUrl())
            .bootstrapDnsHosts(*pins.toTypedArray())
            .includeIPv6(false)
            .build()
    }

    // ---------------- ECH 配置 ----------------

    private class EchEntry(val wire: ByteArray, val expireAt: Long)

    private val echCache = ConcurrentHashMap<String, EchEntry>()
    private val echFailed = ConcurrentHashMap<String, Long>()

    /** 失败冷却：避免每个请求都去打一次注定失败的 DoH */
    private const val FAIL_COOLDOWN_MS = 30_000L
    private const val MIN_TTL_MS = 60_000L
    private const val MAX_TTL_MS = 3_600_000L

    /**
     * 取 ECHConfigList（RFC 9460 的 wire 格式，含 2 字节长度前缀，可直接喂 Conscrypt）。
     * @return null 表示该域名没有 ECH 配置或 DoH 拿不到 —— 调用方据此 fail-closed
     */
    fun echConfigList(host: String): ByteArray? {
        val now = System.currentTimeMillis()
        echCache[host]?.let { if (it.expireAt > now) return it.wire }
        val failedAt = echFailed[host]
        if (failedAt != null && now - failedAt < FAIL_COOLDOWN_MS) return null

        return try {
            val body = query(host, "HTTPS") ?: run {
                echFailed[host] = now
                return null
            }
            val b64 = Regex("ech=([A-Za-z0-9+/=]+)").find(body)?.groupValues?.get(1)
            if (b64 == null) {
                Log.i(TAG, "no ech config for $host")
                echFailed[host] = now
                return null
            }
            val ttl = Regex("\"TTL\"\\s*:\\s*(\\d+)").findAll(body)
                .mapNotNull { it.groupValues[1].toLongOrNull() }
                .minOrNull() ?: 300L
            val wire = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
            echCache[host] = EchEntry(wire, now + (ttl * 1000).coerceIn(MIN_TTL_MS, MAX_TTL_MS))
            echFailed.remove(host)
            Log.i(TAG, "ech config for $host: ${wire.size} bytes, ttl=${ttl}s")
            wire
        } catch (t: Throwable) {
            Log.w(TAG, "ech query failed for $host: ${t.message}")
            echFailed[host] = now
            null
        }
    }

    /** ECH 被服务器拒绝（密钥轮换）后清缓存，下次用服务器给的 retryConfigs 重试 */
    fun invalidateEch(host: String) {
        echCache.remove(host)
        echFailed.remove(host)
    }

    // ---------------- DNS ----------------

    /**
     * 用 DoH 解析域名。失败返回空列表；调用方必须 fail-closed，不要回落系统 DNS（会拿到污染 IP）。
     */
    fun resolve(host: String): List<InetAddress> {
        return try {
            val addrs = dohResolver.lookup(host)
            Log.i(TAG, "doh resolve $host -> ${addrs.joinToString { it.hostAddress ?: "?" }}")
            addrs
        } catch (t: Throwable) {
            Log.w(TAG, "doh resolve failed for $host: ${t.message}")
            emptyList()
        }
    }

    // ---------------- 底层 JSON 查询（仅用于 HTTPS(65) 记录） ----------------

    private fun query(host: String, type: String): String? {
        val req = Request.Builder()
            .url("$DOH_URL?name=$host&type=$type")
            .header("Accept", "application/dns-json")
            .build()
        bootstrapClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                Log.w(TAG, "doh $type HTTP ${resp.code}")
                return null
            }
            return resp.body?.string()
        }
    }
}
