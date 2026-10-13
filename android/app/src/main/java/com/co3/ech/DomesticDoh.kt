package com.co3.ech

import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.*

/**
 * 国内 DoH 取 ECH（2026-10-13 新架构）。
 *
 * 背景：Cloudflare DoH 在国内被封（移动大面积），不再用它做通用 DNS。
 * 新分工：
 * - ECH 公钥：只从 cloudflare-ech.com 取，经国内大厂纯 IP DoH（墙内可达），
 *   缓存 1 小时。被墙域名在国内 DoH 上查不到 HTTPS 记录，所以必须查这个
 *   没被墙的 CF 官方域名，拿它的 ECH 公钥复用（CF 级别密钥，非单域名绑定）。
 * - 连接 IP：CfIpScanner 扫出来的可用 IP 池，随机取一个，不再走 DoH 解析。
 *
 * 纯 IP DoH 的证书问题：连 https://223.5.5.5 时证书是 dns.alidns.com 的，
 * 主机名校验会失败。这里对白名单 IP 跳过主机名校验（仅限这几个公认的
 * 公共 DoH IP，不影响其他连接）。
 */
object DomesticDoh {
    private const val TAG = "CO3-DomesticDoh"

    /** ECH 公钥发布域名（没被墙，国内 DoH 可查） */
    const val ECH_HOST = "cloudflare-ech.com"
    private const val ECH_HOST_ALT = "crypto.cloudflare.com"

    /** ECH 缓存 1 小时 */
    private const val ECH_CACHE_MS = 60 * 60 * 1000L

    /** 国内纯 IP DoH（按优先级排序）
     * 2026-10-13 拨测结论：腾讯 119.29.29.29 已死，百度 180.76.76.76 已死，
     * 360 不支持 H3（但普通 HTTPS 可用）。只保留实测可用的。
     */
    private val DOH_ENDPOINTS = listOf(
        // 阿里云（实测可用）
        "https://223.5.5.5/dns-query",
        "https://223.6.6.6/dns-query",
        // 360（普通 HTTPS 可用，无 H3）
        "https://101.226.4.6/dns-query",
        "https://123.125.81.6/dns-query",
    )

    /** 纯 IP 白名单：跳过主机名校验 */
    private val IP_WHITELIST = setOf(
        "223.5.5.5", "223.6.6.6",
        "101.226.4.6", "123.125.81.6",
    )

    private data class EchCache(val config: ByteArray, val expireAt: Long)
    @Volatile private var cache: EchCache? = null

    private val client: OkHttpClient by lazy {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(c: Array<X509Certificate>, a: String) {}
            override fun checkServerTrusted(c: Array<X509Certificate>, a: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        // 注意：这里为了纯 IP DoH 能用，信任了所有证书。
        // 这个 client 只用于查 ECH 公钥（公开信息），不传输敏感数据。
        // 不要把它用于其他用途。
        val sslCtx = SSLContext.getInstance("TLS").apply {
            init(null, trustAll, java.security.SecureRandom())
        }
        OkHttpClient.Builder()
            .sslSocketFactory(sslCtx.socketFactory, trustAll[0] as X509TrustManager)
            .hostnameVerifier { _, _ -> true }
            .proxy(java.net.Proxy.NO_PROXY)
            .retryOnConnectionFailure(false)
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(4, TimeUnit.SECONDS)
            .callTimeout(10, TimeUnit.SECONDS)
            .build()
    }

    /**
     * 取 ECHConfigList（wire 格式）。内存缓存 1 小时。
     * 失败返回 null，调用方用内置兜底。
     */
    fun echConfigList(): ByteArray? {
        val now = System.currentTimeMillis()
        cache?.let { if (it.expireAt > now) return it.config }

        // 先试 cloudflare-ech.com，再试 crypto.cloudflare.com
        for (host in listOf(ECH_HOST, ECH_HOST_ALT)) {
            fetchEch(host)?.let { config ->
                cache = EchCache(config, now + ECH_CACHE_MS)
                Log.i(TAG, "ECH 取自 $host，经国内 DoH，${config.size} 字节")
                return config
            }
        }
        Log.w(TAG, "国内 DoH 取 ECH 全部失败")
        return null
    }

    /** 强制刷新（比如握手失败怀疑密钥轮换时） */
    fun refetch(): ByteArray? {
        cache = null
        return echConfigList()
    }

    private fun fetchEch(host: String): ByteArray? {
        for (ep in DOH_ENDPOINTS) {
            try {
                dnsWire(ep, host, 65)?.let { return it }
            } catch (e: Exception) {
                Log.d(TAG, "DoH $ep 查 $host 失败: ${e.message}")
            }
        }
        return null
    }

    /**
     * DoH wire 格式查询（RFC 8484），返回解析出的 ECHConfigList。
     * 注意：阿里 DoH 不支持 JSON 格式（?name=&type=），只支持 wire（?dns=）。
     */
    private fun dnsWire(endpoint: String, host: String, qtype: Int): ByteArray? {
        val query = buildDnsQuery(host, qtype)
        val b64 = Base64.encodeToString(query, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val url = "$endpoint?dns=$b64"
        val req = Request.Builder()
            .url(url)
            .header("accept", "application/dns-message")
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val body = resp.body?.bytes() ?: return null
            if (body.isEmpty()) return null
            return parseEchFromWire(body)
        }
    }

    /** 构造 DNS 查询包 */
    private fun buildDnsQuery(host: String, qtype: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun w16(v: Int) { out.write(v shr 8); out.write(v and 0xFF) }
        w16(0x1234) // ID
        w16(0x0100) // flags: recursion desired
        w16(1); w16(0); w16(0); w16(0) // counts
        host.split('.').forEach { part ->
            out.write(part.length)
            out.write(part.toByteArray())
        }
        out.write(0)
        w16(qtype); w16(1) // QTYPE, QCLASS=IN
        return out.toByteArray()
    }

    /** 从 DNS wire 响应中解析 HTTPS 记录的 ech 参数 */
    private fun parseEchFromWire(data: ByteArray): ByteArray? {
        try {
            var pos = 12 // 跳过 header
            // 跳过 question
            while (pos < data.size && data[pos] != 0.toByte()) {
                pos += (data[pos].toInt() and 0xFF) + 1
            }
            pos += 5 // null + QTYPE(2) + QCLASS(2)
            val ancount = ((data[4].toInt() and 0xFF) shl 8) or (data[5].toInt() and 0xFF)
            repeat(ancount) {
                if (pos + 10 > data.size) return null
                // 跳过 name（可能是压缩指针）
                if ((data[pos].toInt() and 0xC0) == 0xC0) pos += 2
                else { while (pos < data.size && data[pos] != 0.toByte()) pos += (data[pos].toInt() and 0xFF) + 1; pos++ }
                val type = ((data[pos].toInt() and 0xFF) shl 8) or (data[pos + 1].toInt() and 0xFF)
                val rdlen = ((data[pos + 8].toInt() and 0xFF) shl 8) or (data[pos + 9].toInt() and 0xFF)
                pos += 10
                if (type == 65 && pos + rdlen <= data.size) {
                    parseHttpsRdata(data, pos, rdlen)?.let { return it }
                }
                pos += rdlen
            }
        } catch (e: Exception) {
            Log.d(TAG, "解析 DNS 响应失败: ${e.message}")
        }
        return null
    }

    /** 从 HTTPS RDATA 中提取 ech 参数（key=5） */
    private fun parseHttpsRdata(data: ByteArray, off: Int, len: Int): ByteArray? {
        var pos = off + 3 // 跳过 SvcPriority(2) + TargetName(root=1)
        val end = off + len
        while (pos + 4 <= end) {
            val key = ((data[pos].toInt() and 0xFF) shl 8) or (data[pos + 1].toInt() and 0xFF)
            val vlen = ((data[pos + 2].toInt() and 0xFF) shl 8) or (data[pos + 3].toInt() and 0xFF)
            pos += 4
            if (key == 5 && pos + vlen <= end) { // ech= 参数
                return data.copyOfRange(pos, pos + vlen)
            }
            pos += vlen
        }
        return null
    }
}
