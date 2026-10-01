package com.co3.ech

import android.util.Base64
import android.util.Log
import com.co3.Diagnostics
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.net.InetAddress
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * DoH 层（瘦身版，2026-10-02 重写）。
 *
 * 只做一件事：**向用户自己的 Cloudflare Gateway 取目标域名的 HTTPS(65) 记录**，
 * 一次查询同时拿到 ECHConfigList + ipv4hint + ipv6hint。
 *
 * 为什么敢这么简单（都是之前 998 行版本用真机日志换来的结论）：
 *   - 「国内 DoH 查被墙域名拿投毒应答」——那是对**国内公共 DoH** 的结论。
 *     自有网关是用户自己的 CF 账号、DoH 加密传输，不存在投毒，所以不需要
 *     "cloudflare-ech.com 借用" 那套逻辑，直接查目标域名自己的记录即可。
 *   - 「网关域名解析被污染」——2026-09-22 出现过一次，但 1daf5fc（网关直连）
 *     在真机 16 次 engine_ok_h3 证明当前系统 DNS 解析网关域名正常。
 *     若日后再现，日志 `doh.query.fail` 会第一时间暴露，再加 bootstrap 也不迟。
 *   - 网关池 TXT 发现 / 种子 DoH / ASN 判定——"换网关不用发版"是伪需求，
 *     CI 十分钟出包；EchHosts 静态表已足够判定保护域。
 *
 * 端点来源：EchDohConfig.load().dohEndpoints（JS initEch 落盘优先，
 * 未落盘时回退 3 个已验证的内置端点），按序尝试。
 *
 * 所有失败都 fail-closed：调用方（EchSocketFactory / EchDns）拿不到就拒绝明文。
 */
object EchDoh {

    private const val TAG = "CO-ECH-DOH"

    /** HTTPS 记录类型。 */
    private const val TYPE_HTTPS = 65
    private const val TYPE_A = 1

    private const val MIN_TTL_MS = 60_000L
    private const val MAX_TTL_MS = 24 * 60 * 60_000L
    private const val DISK_TTL_MS = 24 * 60 * 60_000L

    /** 一次 HTTPS 查询的完整结果。 */
    data class HttpsRecord(
        /** wire 格式 ECHConfigList（含 2 字节长度前缀，ech= 的 base64 解码后原样）。 */
        val ech: ByteArray?,
        val v4: List<String>,
        val v6: List<String>,
        val ttlMs: Long,
    )

    private data class CacheEntry(val record: HttpsRecord, val expireAt: Long)

    private val memCache = ConcurrentHashMap<String, CacheEntry>()
    private val fetchLock = Any()

    private val bootstrapClient: OkHttpClient = OkHttpClient.Builder()
        // 保护域本就不该走代理；DoH 查询更不能走（代理卡死不报错，2026-09-22 教训）
        .proxy(java.net.Proxy.NO_PROXY)
        // 关掉自动重试：一次超时就是一次超时，不放大
        .retryOnConnectionFailure(false)
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        // 总时限兜底
        .callTimeout(8, TimeUnit.SECONDS)
        .build()

    // ---------------- 对外 API ----------------

    /** 内存 → 落盘 → 网关，拿 HTTPS 记录（含 ECH + 地址提示）。 */
    fun record(host: String): HttpsRecord? {
        synchronized(fetchLock) {
            val now = System.currentTimeMillis()
            memCache[host]?.let {
                if (it.expireAt > now) {
                    Diagnostics.trace(
                        "ech.cache.hit",
                        mapOf("host" to host, "ttlLeftMs" to (it.expireAt - now))
                    )
                    return it.record
                } else {
                    memCache.remove(host)
                }
            }
            // 落盘复用：冷启动不再等网关查询（首屏最明显的一段等待就在这）
            EchState.load(host)?.let { wire ->
                val rec = HttpsRecord(wire, emptyList(), emptyList(), MIN_TTL_MS)
                memCache[host] = CacheEntry(rec, now + MIN_TTL_MS)
                Log.i(TAG, "ech config for $host: ${wire.size} bytes（源=落盘）")
                Diagnostics.trace(
                    "ech.state.hit",
                    mapOf(
                        "host" to host, "bytes" to wire.size,
                        "note" to "冷启动读落盘；密钥轮换后这里会短暂用到旧值，握手失败会触发 refetch"
                    )
                )
                // 落盘只有 ech，没有地址提示：顺手在后台补一次全量查询，
                // 让下一次 resolve 直接走内存
                Thread { runCatching { fetchFromGateway(host) } }.start()
                return rec
            }
            return fetchFromGateway(host)
        }
    }

    /** 给 EchSocketFactory：拿 ECHConfigList（wire 格式）。拿不到返回 null → 上层 fail-closed。 */
    fun echConfigList(host: String): ByteArray? = record(host)?.ech

    /**
     * 给 EchDns：拿连接地址。**v4 在前、v6 在后**。
     *
     * 为什么不直接过滤 v6：kathttp3 时代过滤 v6 是因为 QUIC/UDP 上 v6 握手失败；
     * Conscrypt 走 TCP，按 2026-09 的实测移动网 SNI 封锁只针对 v4，v6 可能是旁路。
     * v4 排前面保证优先走最稳的路，又保留 v6 做备选。
     */
    fun resolve(host: String): List<InetAddress> {
        val rec = record(host) ?: return emptyList()
        var ips = (rec.v4 + rec.v6).distinct()
        if (ips.isEmpty()) {
            // HTTPS 记录没有地址提示：退化为查 A 记录
            ips = fetchAddresses(host)
        }
        return ips.mapNotNull { runCatching { InetAddress.getByName(it) }.getOrNull() }
    }

    /**
     * 给重试拦截器：清掉内存 + 落盘缓存，强制从网关取新值。
     * 拿不到返回 null → 上层 fail-closed。
     */
    fun refetchNow(host: String): ByteArray? {
        synchronized(fetchLock) {
            memCache.remove(host)
            EchState.drop(host)
            val rec = fetchFromGateway(host)
            return rec?.ech
        }
    }

    /** 启动预热：后台把记录拉到内存 + 落盘，用户点击时走热路径。 */
    fun prefetch(host: String) {
        Thread {
            runCatching {
                val rec = fetchFromGateway(host)
                Diagnostics.trace(
                    "boot.prewarm.doh",
                    mapOf(
                        "host" to host,
                        "result" to if (rec?.ech != null) "ok" else "fail",
                        "v4n" to (rec?.v4?.size ?: 0),
                    )
                )
            }
        }.apply { priority = Thread.MIN_PRIORITY; start() }
    }

    // ---------------- 网关查询 ----------------

    private fun endpoints(): List<String> = EchDohConfig.load().dohEndpoints

    /** 按序尝试各网关端点，任意一家成功即返回。 */
    private fun fetchFromGateway(host: String): HttpsRecord? {
        val eps = endpoints()
        if (eps.isEmpty()) {
            Log.w(TAG, "无 DoH 端点配置")
            return null
        }
        var lastErr: String? = null
        for (ep in eps) {
            val t0 = System.currentTimeMillis()
            try {
                val rec = queryHttps(ep, host) ?: continue
                val ms = System.currentTimeMillis() - t0
                Diagnostics.trace(
                    "doh.query.ok",
                    mapOf(
                        "host" to host, "via" to ep.substringAfter("https://").substringBefore("/"),
                        "ms" to ms, "echBytes" to (rec.ech?.size ?: 0),
                        "v4n" to rec.v4.size, "v6n" to rec.v6.size, "ttlMs" to rec.ttlMs,
                    )
                )
                memCache[host] = CacheEntry(rec, System.currentTimeMillis() + rec.ttlMs)
                rec.ech?.let { EchState.save(host, it, DISK_TTL_MS) }
                return rec
            } catch (e: Exception) {
                lastErr = "${e.javaClass.simpleName}: ${e.message}"
                Diagnostics.trace(
                    "doh.query.fail",
                    mapOf(
                        "host" to host, "via" to ep.substringAfter("https://").substringBefore("/"),
                        "ms" to (System.currentTimeMillis() - t0), "err" to lastErr,
                    )
                )
            }
        }
        Log.w(TAG, "网关全部失败 $host: $lastErr")
        return null
    }

    /** dns-json 查 HTTPS 记录，解析 ech=/ipv4hint/ipv6hint。 */
    private fun queryHttps(endpoint: String, host: String): HttpsRecord? {
        val json = dnsJson(endpoint, host, TYPE_HTTPS) ?: return null
        var ech: ByteArray? = null
        val v4 = ArrayList<String>()
        val v6 = ArrayList<String>()
        var ttlMs = MAX_TTL_MS
        val answers = json.optJSONArray("Answer") ?: return null
        for (i in 0 until answers.length()) {
            val a = answers.optJSONObject(i) ?: continue
            if (a.optInt("type") != TYPE_HTTPS) continue
            ttlMs = minOf(ttlMs, a.optLong("TTL", 300) * 1000L)
            val data = a.optString("data").orEmpty()
            // "1 . ech=AEj+DQBEAQAg...== ipv4hint=104.20.8.2,104.20.9.2 ipv6hint=..."
            paramValue(data, "ech=")?.let { b64 ->
                runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull()
                    ?.takeIf { it.size > 2 }?.let { ech = it }
            }
            paramValue(data, "ipv4hint=")?.split(",")
                ?.map { it.trim() }?.filter { it.isNotEmpty() }?.let { v4.addAll(it) }
            paramValue(data, "ipv6hint=")?.split(",")
                ?.map { it.trim() }?.filter { it.isNotEmpty() }?.let { v6.addAll(it) }
        }
        if (ech == null && v4.isEmpty() && v6.isEmpty()) return null
        ttlMs = ttlMs.coerceIn(MIN_TTL_MS, MAX_TTL_MS)
        return HttpsRecord(ech, v4.distinct(), v6.distinct(), ttlMs)
    }

    /** dns-json 查 A 记录（HTTPS 无地址提示时的退化路径）。 */
    private fun fetchAddresses(host: String): List<String> {
        val out = ArrayList<String>()
        for (ep in endpoints()) {
            try {
                val json = dnsJson(ep, host, TYPE_A) ?: continue
                val answers = json.optJSONArray("Answer") ?: continue
                for (i in 0 until answers.length()) {
                    val a = answers.optJSONObject(i) ?: continue
                    if (a.optInt("type") != TYPE_A) continue
                    val ip = a.optString("data").trim()
                    if (ip.isNotEmpty()) out.add(ip)
                }
                if (out.isNotEmpty()) return out.distinct()
            } catch (_: Exception) {
            }
        }
        return out.distinct()
    }

    private fun dnsJson(endpoint: String, host: String, type: Int): JSONObject? {
        val url = "$endpoint?name=${URLEncoder.encode(host, "UTF-8")}&type=$type"
        val req = Request.Builder()
            .url(url)
            .header("accept", "application/dns-json")
            .build()
        bootstrapClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("DoH HTTP ${resp.code}")
            val body = resp.body?.string().orEmpty()
            if (body.isEmpty()) throw IOException("DoH 空响应")
            val json = JSONObject(body)
            if (json.optInt("Status", -1) != 0) throw IOException("DoH Status=${json.optInt("Status")}")
            return json
        }
    }

    /** 从 presentation 格式里取 key= 的值（到空格或结尾，去引号）。 */
    private fun paramValue(data: String, key: String): String? {
        val idx = data.indexOf(key)
        if (idx < 0) return null
        var v = data.substring(idx + key.length)
        val sp = v.indexOf(' ')
        if (sp >= 0) v = v.substring(0, sp)
        return v.trim().trim('"').ifEmpty { null }
    }
}
