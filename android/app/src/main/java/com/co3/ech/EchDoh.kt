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

    /** 被服务器拒过的域名：改用「它自己的记录」优先，别一直拿同一份撞。 */
    private val ownFirst = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

    /** 失败冷却：避免每个请求都去打一次注定失败的 DoH */
    private const val FAIL_COOLDOWN_MS = 30_000L
    private const val MIN_TTL_MS = 60_000L
    private const val MAX_TTL_MS = 3_600_000L

    /**
     * 配置的「活源」：CF 官方的 ECH 域名。与 iOS 侧 `echproxy.go` 保持同一套顺序
     * （缓存 → cloudflare-ech.com → 目标自身记录）。
     *
     * 手写/注入到别处的 `ech=` 记录一旦过期，**再拉还是那份旧的**（记录没变、里面的密钥轮换掉了），
     * 拿它去握手只会被服务器拒（Conscrypt 抛 EchRejected）。所以受保护域名一律先取这份实时配置：
     * 跨 zone 注入实测可行，内层 SNI 仍是目标域名，SNI 不外泄。
     */
    private const val LIVE_SOURCE_HOST = "cloudflare-ech.com"

    /** 启动预热的目标域名（本 App 的主站）。 */
    const val WARMUP_HOST = "archiveofourown.org"

    /**
     * 取 ECH 活值的候选：**国内三家的纯 IP 端点**。
     *
     * 为什么用纯 IP：不查 DNS、不被污染、证书直接对 IP 生效（实测均 200）。
     * 为什么不用 `Host` 头：阿里带 `Host` 会直接失败（实测 http=000），
     * 三家在"不带 Host + `?dns=`"下都正常 —— 所以一律用 URL 里的 IP 当 Host。
     * 为什么只认 wire：三家都不支持 JSON（阿里/360 回 400 no 'dns' query parameter，
     * 腾讯回 UrlParameterError），只能发二进制 dns-message。
     *
     * 策略：**随机挑一家试，失败换下一家**（不同时打、也不重复打同一家）。
     */
    private val ECH_DOH_IPS = listOf(
        "223.5.5.5",        // 阿里
        "223.6.6.6",        // 阿里备
        "1.12.12.12",       // 腾讯
        "120.53.53.53",     // 腾讯备
        "101.198.193.29",   // 360
        "101.198.192.33",   // 360 备
    )

    /** 单家超时：快失败快换下一家，避免首次启动干等。 */
    private const val ECH_ONE_TIMEOUT_MS = 2500L
    /** ECH 配置缓存下限：记录的 TTL 只有 ~198s，但公钥实测能稳定数天；
     *  缓存久一点才能真正省掉冷启动那次查询；万一被轮换，握手被拒会走 invalidateEch 自愈。 */
    private const val ECH_CACHE_MIN_MS = 60 * 60 * 1000L
    private const val ECH_CACHE_MAX_MS = 5 * 60 * 60 * 1000L

    /** 从随机一家纯 IP DoH 取官方活值（wire 格式，解析 SVCB 的 key=5）。 */
    private fun fetchLiveEch(): Pair<ByteArray, Long>? {
        val order = ECH_DOH_IPS.shuffled()
        for (ip in order) {
            val hit = runCatching { queryEchWire(ip, LIVE_SOURCE_HOST) }.getOrNull()
            if (hit != null) {
                Log.i(TAG, "live ech via $ip: ${hit.first.size} bytes, ttl=${hit.second}ms")
                return hit
            }
            Log.i(TAG, "live ech via $ip failed, next")
        }
        return null
    }

    /** 建 DNS 查询（type 65 = HTTPS）。 */
    private fun buildQuery(name: String): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        out.write(byteArrayOf(0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0))
        name.split('.').forEach { lb -> out.write(lb.length); out.write(lb.toByteArray()) }
        out.write(0)
        out.write(byteArrayOf(0x00, 65, 0x00, 0x01))
        return out.toByteArray()
    }

    /** 纯 IP + wire 的 DoH 查询；返回 ech（含 2 字节长度前缀）+ 缓存时长。 */
    private fun queryEchWire(ip: String, name: String): Pair<ByteArray, Long>? {
        val b64 = android.util.Base64.encodeToString(
            buildQuery(name), android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE,
        ).trimEnd('=')
        val req = okhttp3.Request.Builder()
            .url("https://$ip/dns-query?dns=$b64")
            .header("accept", "application/dns-message")
            .build()
        // 注意：绝不加 Host 头（阿里带 Host 会失败）；URL 的 host 就是 IP，证书对 IP 生效
        val wire = bootstrapClient.newBuilder()
            .connectTimeout(ECH_ONE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(ECH_ONE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(ECH_ONE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build()
            .newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                resp.body?.bytes() ?: return null
            }
        return parseSvcbEch(wire)
    }

    /**
     * 解析 DNS 应答，找 type=65 的 HTTPS 记录，走 SvcParams 取 key=5（ech）。
     * 返回的字节**含 2 字节长度前缀**，可直接喂 Conscrypt（实测：值以 0x00 0x45 开头，0x45=69）。
     */
    private fun parseSvcbEch(msg: ByteArray): Pair<ByteArray, Long>? {
        if (msg.size < 12) return null
        var i = 12
        // 跳过 question
        while (i < msg.size && msg[i].toInt() != 0) i += (msg[i].toInt() and 0xFF) + 1
        i += 5
        val ancount = ((msg[6].toInt() and 0xFF) shl 8) or (msg[7].toInt() and 0xFF)
        for (n in 0 until ancount) {
            if (i + 12 > msg.size) return null
            if ((msg[i].toInt() and 0xC0) == 0xC0) i += 2
            else { while (i < msg.size && msg[i].toInt() != 0) i += (msg[i].toInt() and 0xFF) + 1; i += 1 }
            val type = ((msg[i].toInt() and 0xFF) shl 8) or (msg[i + 1].toInt() and 0xFF)
            val ttl = (((msg[i + 4].toInt() and 0xFF).toLong() shl 24) or
                ((msg[i + 5].toInt() and 0xFF).toLong() shl 16) or
                ((msg[i + 6].toInt() and 0xFF).toLong() shl 8) or
                (msg[i + 7].toInt() and 0xFF).toLong())
            val rdlen = ((msg[i + 8].toInt() and 0xFF) shl 8) or (msg[i + 9].toInt() and 0xFF)
            val rdata = i + 10
            if (type == 65 && rdlen > 4 && rdata + rdlen <= msg.size) {
                // SVCB: priority(2) + target(域名) + SvcParams
                var j = rdata + 2
                while (j < rdata + rdlen && msg[j].toInt() != 0) j += (msg[j].toInt() and 0xFF) + 1
                j += 1
                while (j + 4 <= rdata + rdlen) {
                    val key = ((msg[j].toInt() and 0xFF) shl 8) or (msg[j + 1].toInt() and 0xFF)
                    val len = ((msg[j + 2].toInt() and 0xFF) shl 8) or (msg[j + 3].toInt() and 0xFF)
                    if (key == 5 && len > 0) {
                        val ech = msg.copyOfRange(j + 4, j + 4 + len)
                        val ttlMs = (ttl * 1000).coerceIn(ECH_CACHE_MIN_MS, ECH_CACHE_MAX_MS - 1) + 1
                        return ech to ttlMs
                    }
                    j += 4 + len
                }
            }
            i = rdata + rdlen
        }
        return null
    }

    /**
     * 取 ECHConfigList（RFC 9460 的 wire 格式，含 2 字节长度前缀，可直接喂 Conscrypt）。
     * @return null 表示该域名没有 ECH 配置或 DoH 拿不到 —— 调用方据此 fail-closed
     */
    fun echConfigList(host: String): ByteArray? {
        val now = System.currentTimeMillis()
        echCache[host]?.let { if (it.expireAt > now) return it.wire }
        // 落盘复用：冷启动不再等网关查询（首屏最明显的一段等待就在这）
        EchState.load(host)?.let {
            echCache[host] = EchEntry(it, now + MIN_TTL_MS)
            Log.i(TAG, "ech config for $host: ${it.size} bytes（源=落盘）")
            return it
        }
        val failedAt = echFailed[host]
        if (failedAt != null && now - failedAt < FAIL_COOLDOWN_MS) return null

        // 先走哪条路：默认官方活源；被翻过标志位的域名先用它自己的记录。
        val first = if (host != LIVE_SOURCE_HOST && !ownFirst.contains(host)) LIVE_SOURCE_HOST else host
        val second = if (first == host) LIVE_SOURCE_HOST else host
        val hit = try {
            // 活值优先：国内三家纯 IP（随机一家，失败换下一家）；失败才回退网关的 JSON 链路
            if (first == LIVE_SOURCE_HOST) fetchLiveEch() ?: fetchConfig(first, now)
            else fetchConfig(first, now) ?: (if (second == LIVE_SOURCE_HOST) fetchLiveEch() else fetchConfig(second, now))
        } catch (t: Throwable) {
            Log.w(TAG, "ech query failed for $host: ${t.message}")
            null
        }
        if (hit == null) {
            Log.i(TAG, "no ech config for $host（已试：$first / $second）")
            echFailed[host] = now
            return null
        }
        val (wire, ttlMs) = hit
        echCache[host] = EchEntry(wire, now + ttlMs)
        EchState.save(host, wire, ttlMs)
        echFailed.remove(host)
        Log.i(TAG, "ech config for $host: ${wire.size} bytes（源=$first）")
        return wire
    }

    /** 查某个域名的 HTTPS(65) 记录并解出配置：wire（含 2 字节长度前缀）+ 缓存时长。 */
    private fun fetchConfig(name: String, now: Long): Pair<ByteArray, Long>? {
        val body = query(name, "HTTPS") ?: return null
        val b64 = Regex("ech=([A-Za-z0-9+/=]+)").find(body)?.groupValues?.get(1)
        if (b64 == null) {
            Log.i(TAG, "no ech config in record of $name")
            return null
        }
        val ttl = Regex("\"TTL\"\\s*:\\s*(\\d+)").findAll(body)
            .mapNotNull { it.groupValues[1].toLongOrNull() }
            .minOrNull() ?: 300L
        val wire = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
        return wire to (ttl * 1000).coerceIn(MIN_TTL_MS, MAX_TTL_MS)
    }

    /**
     * ECH 被服务器拒绝（密钥轮换 / 配置失效）后清缓存。
     * 活源那份也一起丢（它可能正是被拒的那份），并把这个域名翻成「用它自己的记录」，
     * 否则重试会拿回同一个值、一直撞同一堵墙。
     */
    fun invalidateEch(host: String) {
        echCache.remove(host)
        EchState.drop(host)
        echFailed.remove(host)
        echCache.remove(LIVE_SOURCE_HOST)
        if (host != LIVE_SOURCE_HOST) ownFirst.add(host)
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
