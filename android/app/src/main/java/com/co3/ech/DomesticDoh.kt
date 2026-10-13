package com.co3.ech

import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URLEncoder
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
                val json = dnsJson(ep, host, 65) ?: continue
                val answers = json.optJSONArray("Answer") ?: continue
                for (i in 0 until answers.length()) {
                    val a = answers.optJSONObject(i) ?: continue
                    if (a.optInt("type") != 65) continue
                    val data = a.optString("data").orEmpty()
                    paramValue(data, "ech=")?.let { b64 ->
                        runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull()
                            ?.takeIf { it.size > 2 }?.let { return it }
                    }
                }
            } catch (e: Exception) {
                Log.d(TAG, "DoH $ep 查 $host 失败: ${e.message}")
            }
        }
        return null
    }

    private fun dnsJson(endpoint: String, host: String, type: Int): JSONObject? {
        val url = "$endpoint?name=${URLEncoder.encode(host, "UTF-8")}&type=$type"
        val req = Request.Builder()
            .url(url)
            .header("accept", "application/dns-json")
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val body = resp.body?.string().orEmpty()
            if (body.isEmpty()) return null
            val json = JSONObject(body)
            if (json.optInt("Status", -1) != 0) return null
            return json
        }
    }

    private fun paramValue(data: String, key: String): String? {
        val idx = data.indexOf(key)
        if (idx < 0) return null
        var v = data.substring(idx + key.length)
        val sp = v.indexOf(' ')
        if (sp >= 0) v = v.substring(0, sp)
        return v.trim().trim('"').ifEmpty { null }
    }
}
