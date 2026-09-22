package com.co3.ech

import android.util.Log
import com.co3.Diagnostics
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

    /** 云端 DoH 网关的**内置默认**；实际用哪个由网关池（TXT）决定。 */
    const val DOH_URL = "https://82sew1c85i.cloudflare-gateway.com/dns-query"

    /**
     * 配置域名：TXT 记录里发布**网关池**（一行一个 DoH 端点 URL）。
     *
     * 这是「网关可换」那一环 —— 换网关只改这条 TXT，App 不用重新编译发版。
     * 只由国内种子 DoH 去读（纯 IP 直连，天然免疫污染）；实测六家国内 DoH
     * （阿里/腾讯/360 各两台）都能完整取到 4 条。
     *
     * 解析器同时兼容两种写法：
     *   · 纯 URL 列表        —— 当前用的形式
     *   · key=value          —— `doh=https://…` / `doh2=https://…,https://…`
     */
    private const val CONFIG_TXT_DOMAIN = "doh.xn--pn1aul.eu.org"
    private const val GATEWAY_POOL_TTL_MS = 30 * 60 * 1000L
    private const val GATEWAY_IP_TTL_MS = 30 * 60 * 1000L

    /**
     * 网关地址的**末位后备**（正常情况下用不到）。
     *
     * 网关真相不写死在这里：先用国内种子 DoH 读配置域名的 TXT 拿到网关池（见 [gatewayPool]），
     * 再动态解析出选定端点的地址（见 [currentGateway]）。
     * 理由：
     *   · 硬编码 IP 迟早失效 —— 网关可更换、地址段会被封、CF 边缘也会变；
     *   · 而走系统 DNS 解析网关域名又会被污染（拿到假 IP → 连接超时）。
     * 所以「网关在哪」交给国内 DoH 回答；这份清单只在**连国内 DoH 都失败**时兜底。
     *
     * 2026-09-22 用户拨测确认：`162.159.36.x` 与 `172.64.229.x` 两组 IP 在国内都是通的。
     * 之前那条 21 秒超时不是 IP 不通 —— 是**网关域名解析被污染**，连到了假地址。
     * （这也解释了为什么同一客户端连 `223.5.5.5` 只要 158ms：那家是纯 IP，无需解析。）
     */
    private val DOH_FALLBACK_IPS = listOf(
        "172.64.229.4", "172.64.229.128", "162.159.36.20", "162.159.36.5",
    )

    private val bootstrapClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    /**
     * 【种子层】用国内纯 IP DoH 解析一个域名的地址（A + AAAA）。
     *
     * 这是整套链路的地基。域名若交给系统 DNS 就会被污染（拿到假 IP → 连接超时），
     * 而写死 IP 又会随网关更换 / 地址段被封而失效。
     * 国内三家 DoH 是**纯 IP 直连** —— 查它们本身不需要任何解析，天然免疫污染 ——
     * 所以「网关在哪」交给它们回答。
     *
     * 任意一家成功即返回，失败换下一家。
     */
    private fun resolveHostIps(host: String): List<String> {
        val out = LinkedHashSet<String>()
        for (ip in ECH_DOH_IPS.shuffled()) {
            for (type in intArrayOf(1, 28)) {
                val wire = dohWire(ip, host, type) ?: continue
                out.addAll(parseAddresses(wire))
            }
            if (out.isNotEmpty()) {
                Diagnostics.trace(
                    "doh.hostres.ok",
                    mapOf("host" to host, "via" to ip, "n" to out.size, "ips" to out.joinToString(","))
                )
                break
            }
            Diagnostics.trace("doh.hostres.miss", mapOf("host" to host, "via" to ip))
        }
        return out.toList()
    }

    /** 解析 DNS 应答里的 TXT(16) 记录（rdata 是若干 character-string，需拼接）。 */
    private fun parseTxt(msg: ByteArray): List<String> {
        if (msg.size < 12) return emptyList()
        var i = 12
        while (i < msg.size && msg[i].toInt() != 0) i += (msg[i].toInt() and 0xFF) + 1
        i += 5
        val ancount = ((msg[6].toInt() and 0xFF) shl 8) or (msg[7].toInt() and 0xFF)
        val out = ArrayList<String>()
        for (n in 0 until ancount) {
            if (i + 12 > msg.size) break
            if ((msg[i].toInt() and 0xC0) == 0xC0) i += 2
            else { while (i < msg.size && msg[i].toInt() != 0) i += (msg[i].toInt() and 0xFF) + 1; i += 1 }
            val rtype = ((msg[i].toInt() and 0xFF) shl 8) or (msg[i + 1].toInt() and 0xFF)
            val rdlen = ((msg[i + 8].toInt() and 0xFF) shl 8) or (msg[i + 9].toInt() and 0xFF)
            val rdata = i + 10
            if (rtype == 16 && rdata + rdlen <= msg.size) {
                val sb = StringBuilder()
                var p = rdata
                while (p < rdata + rdlen) {
                    val ln = msg[p].toInt() and 0xFF
                    if (p + 1 + ln > rdata + rdlen) break
                    sb.append(String(msg, p + 1, ln, Charsets.UTF_8))
                    p += 1 + ln
                }
                if (sb.isNotEmpty()) out.add(sb.toString())
            }
            i = rdata + rdlen
        }
        return out
    }

    /**
     * 从 TXT 内容里挑出 DoH 端点 URL。兼容两种写法：
     *   · 纯 URL 列表 —— 当前配置域名用的形式
     *   · key=value  —— `doh=https://…` / `doh2=https://…,https://…`
     */
    private fun extractGatewayUrls(txt: String): List<String> =
        txt.split(',', ';', ' ', '\n')
            .map { it.trim() }
            .map { seg -> if (seg.contains('=')) seg.substringAfter('=').trim() else seg }
            .filter { it.startsWith("https://") && it.contains("/dns-query") }

    /** 用国内种子 DoH 读配置域名的 TXT → 网关池。 */
    private fun fetchGatewayPool(): List<String> {
        for (ip in ECH_DOH_IPS.shuffled()) {
            val wire = dohWire(ip, CONFIG_TXT_DOMAIN, 16) ?: continue
            val urls = parseTxt(wire).flatMap { extractGatewayUrls(it) }.distinct()
            if (urls.isNotEmpty()) {
                Diagnostics.trace(
                    "doh.pool.ok",
                    mapOf("via" to ip, "n" to urls.size, "urls" to urls.joinToString(","))
                )
                return urls
            }
            Diagnostics.trace("doh.pool.miss", mapOf("via" to ip))
        }
        return emptyList()
    }

    @Volatile private var poolCache: Pair<List<String>, Long>? = null

    /** 网关池（带 TTL 缓存）；TXT 读不到就用内置默认。 */
    private fun gatewayPool(): List<String> {
        val now = System.currentTimeMillis()
        poolCache?.let { (u, exp) -> if (exp > now && u.isNotEmpty()) return u }
        val urls = fetchGatewayPool()
        if (urls.isEmpty()) {
            Diagnostics.trace("doh.pool.fallback", mapOf("url" to DOH_URL))
            return listOf(DOH_URL)
        }
        poolCache = urls to (now + GATEWAY_POOL_TTL_MS)
        return urls
    }

    /** 选定的网关：URL + 域名 + 已解析出的地址。 */
    private class Gateway(val url: String, val host: String, val ips: List<String>)

    @Volatile private var gatewayCache: Pair<Gateway, Long>? = null

    /**
     * 从网关池里挑第一个**能解析出地址**的端点。
     *
     * 换网关只要改 TXT —— 池里哪个能用就用哪个；全都不行才回落内置默认。
     */
    private fun currentGateway(): Gateway? {
        val now = System.currentTimeMillis()
        gatewayCache?.let { (g, exp) -> if (exp > now) return g }
        for (url in gatewayPool()) {
            val host = runCatching { url.toHttpUrl().host }.getOrNull() ?: continue
            val ips = resolveHostIps(host)
            if (ips.isEmpty()) {
                Diagnostics.trace("doh.gateway.unusable", mapOf("url" to url))
                continue
            }
            val g = Gateway(url, host, ips)
            gatewayCache = g to (now + GATEWAY_IP_TTL_MS)
            Diagnostics.trace("doh.gateway.ok", mapOf("url" to url, "ips" to ips.joinToString(",")))
            return g
        }
        return null
    }

    /** 网关不可达时调用：丢缓存，下次重新读 TXT 并重新解析（网关可能已换）。 */
    private fun invalidateGateway() {
        gatewayCache = null
        poolCache = null
        resolverCache = null
    }

    @Volatile private var resolverCache: Pair<DnsOverHttps, String>? = null

    /**
     * 官方 DoH 解析器：A/AAAA + TTL 缓存，用于解析受保护域名（防污染 + 兜底）。
     *
     * 端点与 bootstrap 地址都来自 [currentGateway]（先读 TXT 拿网关池 → 再动态解析地址），
     * 任一变化就重建 —— 所以**换网关只要改配置域名的 TXT，不需要动代码**。
     */
    private fun dohResolver(): DnsOverHttps {
        val gw = currentGateway()
        val url = (gw?.url ?: DOH_URL).toHttpUrl()
        val ips = gw?.ips ?: DOH_FALLBACK_IPS
        val key = url.toString() + "|" + ips.joinToString(",")
        resolverCache?.let { (r, k) -> if (k == key) return r }
        val pins = ips.mapNotNull { runCatching { InetAddress.getByName(it) }.getOrNull() }
        val built = DnsOverHttps.Builder()
            .client(bootstrapClient)
            .url(url)
            .bootstrapDnsHosts(*pins.toTypedArray())
            // ⚠️ 必须 true。移动网络的 SNI 封锁**只针对 IPv4**，禁掉 IPv6 等于自断后路 ——
            // 这正是 Han1meViewer 上"Chrome 能开、App 打不开"的同一个根因
            // （Chrome 走 IPv6 绕过了封锁，App 只有 IPv4 就被掐）。
            .includeIPv6(true)
            .build()
        resolverCache = built to key
        return built
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

    /**
     * ECH 配置缓存时长。
     *
     * ⚠️ **绝不能设大**。旧值曾是「下限 1 小时 / 上限 5 小时」，注释理由是
     * "公钥实测能稳定数天" —— 但密钥轮换时这个假设直接失效，结果是轮换后
     * 最长 1 小时都拿旧密钥去撞墙，功能看起来"一直坏着"。
     *
     * 规则（用户定的，也是浏览器语义）：
     *   cloudflare-ech.com 永远是权威正确值；**任何失败都立即去那里取新值**，
     *   不管缓存了多久。所以缓存只用于"省掉重复查询"，绝不能成为"用旧值硬扛"的理由。
     * 记录本身的 TTL 只有 ~198s，这里就跟着它走，最多 30 分钟。
     */
    private const val ECH_CACHE_MIN_MS = 60_000L              // 1 分钟
    private const val ECH_CACHE_MAX_MS = 30 * 60 * 1000L      // 30 分钟

    /**
     * HTTPS(65) 记录解析结果：**一次查询同时拿到 ECH 配置与地址提示**。
     *
     * 为什么合并：RFC 9460 的 HTTPS 记录本身就同时携带
     *   ech(key=5) + ipv4hint(key=4) + ipv6hint(key=6)
     * 实测国内三家 DoH 查 archiveofourown.org 全部完整返回：
     *   v4=104.20.8.2,104.20.9.2  v6=2606:4700:10::…  ech=71B  ttl=116~600s
     *
     * 而旧实现把这两件事拆成两条路：
     *   ① ECH 配置 → fetchLiveEch() 走国内三家纯 IP      → ✅ 158ms
     *   ② A/AAAA   → dohResolver 走自有网关(162.159.36.x) → ❌ 每次卡 17~21 秒后 0 地址
     * 用户网络下 ② 根本连不上，于是整个 ECH 链路 fail-closed。
     * 合并后只需要一次查询，且走的是国内可达的纯 IP。
     */
    private class HttpsRecord(
        val ech: ByteArray?,
        val ipv4: List<String>,
        val ipv6: List<String>,
        val ttlMs: Long,
    )

    private val httpsRecordCache = ConcurrentHashMap<String, Pair<HttpsRecord, Long>>()

    /** 从随机一家纯 IP DoH 取官方活值（wire 格式，解析 SVCB 的 key=5）。 */
    private fun fetchLiveEch(): Pair<ByteArray, Long>? {
        return fetchLiveRecord(LIVE_SOURCE_HOST)?.let { rec ->
            rec.ech?.let { it to rec.ttlMs }
        }
    }

    /**
     * 走国内三家纯 IP DoH 取某个域名的完整 HTTPS 记录（ech + 地址提示）。
     * 随机挑一家、2.5s 超时、失败换下一家（与既有 fetchLiveEch 的策略一致）。
     */
    private fun fetchLiveRecord(host: String): HttpsRecord? {
        val order = ECH_DOH_IPS.shuffled()
        for (ip in order) {
            val rec = runCatching { queryHttpsRecord(ip, host) }.getOrNull()
            if (rec != null) {
                Diagnostics.trace(
                    "ech.record.ok",
                    mapOf(
                        "host" to host, "via" to ip,
                        "echBytes" to (rec.ech?.size ?: 0),
                        "v4" to rec.ipv4.joinToString(","), "v6n" to rec.ipv6.size,
                        "ttlMs" to rec.ttlMs,
                    )
                )
                return rec
            }
            Diagnostics.trace("ech.record.miss", mapOf("host" to host, "via" to ip))
        }
        return null
    }

    /** 建 DNS 查询。type: 1=A, 28=AAAA, 65=HTTPS。 */
    private fun buildQuery(name: String, type: Int = 65): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        out.write(byteArrayOf(0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0))
        name.split('.').forEach { lb -> out.write(lb.length); out.write(lb.toByteArray()) }
        out.write(0)
        out.write(byteArrayOf(0x00, type.toByte(), 0x00, 0x01))
        return out.toByteArray()
    }

    /** 纯 IP DoH 查询的公共通道（绝不加 Host 头；URL 的 host 就是 IP，证书对 IP 生效）。 */
    private fun dohWire(ip: String, name: String, type: Int): ByteArray? {
        val b64 = android.util.Base64.encodeToString(
            buildQuery(name, type), android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE,
        ).trimEnd('=')
        val req = okhttp3.Request.Builder()
            .url("https://$ip/dns-query?dns=$b64")
            .header("accept", "application/dns-message")
            .build()
        return runCatching {
            bootstrapClient.newBuilder()
                .connectTimeout(ECH_ONE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(ECH_ONE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .callTimeout(ECH_ONE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build()
                .newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) null else resp.body?.bytes()
                }
        }.getOrNull()
    }

    /** 从 DNS 应答里收集 A(1) / AAAA(28) 地址（顺带兼容 CNAME 链：应答里有什么就收什么）。 */
    private fun parseAddresses(msg: ByteArray): List<String> {
        if (msg.size < 12) return emptyList()
        var i = 12
        while (i < msg.size && msg[i].toInt() != 0) i += (msg[i].toInt() and 0xFF) + 1
        i += 5
        val ancount = ((msg[6].toInt() and 0xFF) shl 8) or (msg[7].toInt() and 0xFF)
        val out = ArrayList<String>()
        for (n in 0 until ancount) {
            if (i + 12 > msg.size) break
            if ((msg[i].toInt() and 0xC0) == 0xC0) i += 2
            else { while (i < msg.size && msg[i].toInt() != 0) i += (msg[i].toInt() and 0xFF) + 1; i += 1 }
            val rtype = ((msg[i].toInt() and 0xFF) shl 8) or (msg[i + 1].toInt() and 0xFF)
            val rdlen = ((msg[i + 8].toInt() and 0xFF) shl 8) or (msg[i + 9].toInt() and 0xFF)
            val rdata = i + 10
            if (rdata + rdlen <= msg.size) {
                if (rtype == 1 && rdlen == 4) {
                    out.add(
                        "${msg[rdata].toInt() and 0xFF}.${msg[rdata + 1].toInt() and 0xFF}." +
                            "${msg[rdata + 2].toInt() and 0xFF}.${msg[rdata + 3].toInt() and 0xFF}"
                    )
                } else if (rtype == 28 && rdlen == 16) {
                    runCatching {
                        out.add(java.net.InetAddress.getByAddress(msg.copyOfRange(rdata, rdata + 16)).hostAddress ?: "")
                    }
                }
            }
            i = rdata + rdlen
        }
        return out.filter { it.isNotEmpty() }
    }

    /** 纯 IP + wire 的 DoH 查询，解析完整 HTTPS 记录（ech + ipv4hint + ipv6hint）。 */
    private fun queryHttpsRecord(ip: String, name: String): HttpsRecord? {
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
        return parseHttpsRecord(wire)
    }

    /**
     * 解析 DNS 应答，找 type=65 的 HTTPS 记录，取出 SvcParams：
     *   key=5 ech（含 2 字节长度前缀，可直接喂 Conscrypt）
     *   key=4 ipv4hint（4 字节一个地址）
     *   key=6 ipv6hint（16 字节一个地址）
     * 三者一次拿全 —— 这样解析 IP 与取 ECH 配置走的是同一批国内可达的纯 IP。
     */
    private fun parseHttpsRecord(msg: ByteArray): HttpsRecord? {
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
                var ech: ByteArray? = null
                val v4 = ArrayList<String>()
                val v6 = ArrayList<String>()
                while (j + 4 <= rdata + rdlen) {
                    val key = ((msg[j].toInt() and 0xFF) shl 8) or (msg[j + 1].toInt() and 0xFF)
                    val len = ((msg[j + 2].toInt() and 0xFF) shl 8) or (msg[j + 3].toInt() and 0xFF)
                    val vStart = j + 4
                    if (vStart + len <= rdata + rdlen) {
                        when (key) {
                            5 -> if (len > 0) ech = msg.copyOfRange(vStart, vStart + len)
                            4 -> {
                                var k = vStart
                                while (k + 3 < vStart + len) {
                                    v4.add("${msg[k].toInt() and 0xFF}.${msg[k+1].toInt() and 0xFF}.${msg[k+2].toInt() and 0xFF}.${msg[k+3].toInt() and 0xFF}")
                                    k += 4
                                }
                            }
                            6 -> {
                                var k = vStart
                                while (k + 15 < vStart + len) {
                                    runCatching {
                                        v6.add(java.net.InetAddress.getByAddress(msg.copyOfRange(k, k + 16)).hostAddress ?: "")
                                    }
                                    k += 16
                                }
                            }
                        }
                    }
                    j += 4 + len
                }
                val ttlMs = (ttl * 1000).coerceIn(ECH_CACHE_MIN_MS, ECH_CACHE_MAX_MS - 1) + 1
                return HttpsRecord(ech, v4, v6, ttlMs)
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
        echCache[host]?.let {
            if (it.expireAt > now) {
                Diagnostics.trace(
                    "ech.cache.hit",
                    mapOf("host" to host, "bytes" to it.wire.size, "ttlLeftMs" to (it.expireAt - now))
                )
                return it.wire
            }
        }
        // 落盘复用：冷启动不再等网关查询（首屏最明显的一段等待就在这）
        EchState.load(host)?.let {
            echCache[host] = EchEntry(it, now + MIN_TTL_MS)
            Log.i(TAG, "ech config for $host: ${it.size} bytes（源=落盘）")
            Diagnostics.trace(
                "ech.state.hit",
                mapOf("host" to host, "bytes" to it.size,
                      "note" to "冷启动读落盘；密钥轮换后这里会短暂用到旧值")
            )
            return it
        }
        val failedAt = echFailed[host]
        if (failedAt != null && now - failedAt < FAIL_COOLDOWN_MS) {
            Diagnostics.trace(
                "ech.cooldown",
                mapOf("host" to host, "ageMs" to (now - failedAt),
                      "cooldownMs" to FAIL_COOLDOWN_MS,
                      "note" to "上次失败后的冷却期内，直接放弃 → 上层 fail-closed")
            )
            return null
        }

        // 先走哪条路：默认官方活源；被翻过标志位的域名先用它自己的记录。
        val first = if (host != LIVE_SOURCE_HOST && !ownFirst.contains(host)) LIVE_SOURCE_HOST else host
        val second = if (first == host) LIVE_SOURCE_HOST else host
        Diagnostics.trace(
            "ech.fetch.begin",
            mapOf("host" to host, "first" to first, "second" to second,
                  "ownFirst" to ownFirst.contains(host))
        )
        val hit = try {
            // ① 优先用**目标域名自己的** HTTPS 记录：实测它同时带 ech(71B) 与
            //    ipv4hint/ipv6hint，一次查询就把「配置」和「IP」都解决了。
            //    （AO3 的 ech 与 cloudflare-ech.com 的活值本就同源，不存在"必须借用"的问题）
            val ownRec = httpsRecord(host)
            val ownEch = ownRec?.ech
            if (ownEch != null) {
                Diagnostics.trace(
                    "ech.fetch.own",
                    mapOf(
                        "host" to host, "bytes" to ownEch.size,
                        "v4" to ownRec.ipv4.joinToString(","), "v6n" to ownRec.ipv6.size,
                    )
                )
                ownEch to ownRec.ttlMs
            } else {
                // ② 借用路径：某些域名自己的记录里没有 ech（例：未挂 CF custom hostname），
                //    此时才去 cloudflare-ech.com 取官方活值。这条路径没有地址提示，
                //    resolve() 会退回自有网关。
                Diagnostics.trace(
                    "ech.fetch.borrow",
                    mapOf("host" to host, "first" to first, "second" to second)
                )
                if (first == LIVE_SOURCE_HOST) fetchLiveEch() ?: fetchConfig(first, now)
                else fetchConfig(first, now) ?: (if (second == LIVE_SOURCE_HOST) fetchLiveEch() else fetchConfig(second, now))
            }
        } catch (t: Throwable) {
            Log.w(TAG, "ech query failed for $host: ${t.message}")
            Diagnostics.trace(
                "ech.fetch.throw",
                mapOf("host" to host, "err" to "${t.javaClass.simpleName}: ${t.message}")
            )
            null
        }
        if (hit == null) {
            Log.i(TAG, "no ech config for $host（已试：$first / $second）")
            Diagnostics.trace(
                "ech.fetch.allFail",
                mapOf("host" to host, "tried" to "$first / $second",
                      "note" to "所有来源都拿不到 ECH 配置 → 进入 30s 冷却 → 上层 fail-closed")
            )
            echFailed[host] = now
            return null
        }
        val (wire, ttlMs) = hit
        echCache[host] = EchEntry(wire, now + ttlMs)
        EchState.save(host, wire, ttlMs)
        echFailed.remove(host)
        Log.i(TAG, "ech config for $host: ${wire.size} bytes（源=$first）")
        Diagnostics.trace(
            "ech.fetch.ok",
            mapOf("host" to host, "bytes" to wire.size, "ttlMs" to ttlMs, "src" to first)
        )
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
     * 清掉这个域名的一切 ECH 缓存，逼下一次重新取。
     *
     * ⚠️ 必须清得**彻底** —— 任何一处残留都会让下一次取用又拿到旧值：
     *   echCache    内存缓存（按域名 + 权威源各一份）
     *   EchState    落盘
     *   echFailed   失败冷却（不清就被 30s 冷却挡住，无法立刻重取）
     *   ownFirst    "优先用自己记录"的偏好
     *
     * 规则（用户定的，也是浏览器语义）：**cloudflare-ech.com 永远是权威正确值；
     * 只要失败，不管缓存了多久，就立刻去取新值** —— 缓存只用于省掉重复查询，
     * 绝不能成为"拿旧密钥硬扛"的理由。
     */
    fun invalidateEch(host: String) {
        echCache.remove(host)
        EchState.drop(host)
        echFailed.remove(host)
        echCache.remove(LIVE_SOURCE_HOST)
        // 新加的 HTTPS 记录缓存（ech + 地址提示）同样必须清 —— 它就是「配置+IP」的来源，
        // 留着不清等于下次仍然拿旧记录，跟没清一样。
        invalidateHttpsRecord(host)
        invalidateHttpsRecord(LIVE_SOURCE_HOST)
        // 旧实现这里是 ownFirst.add(host)，让该域名**永久**偏向"自己的记录"——
        // 但那份记录可能同样是旧的，等于换个地方继续撞墙，而且再也回不到权威源。
        // 改为清除：下次仍然优先权威源。
        ownFirst.remove(host)
    }

    /**
     * 失效并**立即**重取。用户规则：失败就去权威源拿正确值，并缓存起来。
     * @return 新拿到的配置；权威源也没拿到则返回 null（调用方继续 fail-closed）
     */
    fun refetchNow(host: String): ByteArray? {
        invalidateEch(host)
        return echConfigList(host)
    }

    // ---------------- DNS ----------------

    /**
     * 取某域名的完整 HTTPS 记录（带缓存）。
     * resolve 与 echConfigList 共用这一份，避免同一个域名打两次 DoH。
     */
    private fun httpsRecord(host: String): HttpsRecord? {
        val now = System.currentTimeMillis()
        httpsRecordCache[host]?.let { (rec, expireAt) -> if (expireAt > now) return rec }
        val rec = fetchLiveRecord(host) ?: return null
        httpsRecordCache[host] = rec to (now + rec.ttlMs)
        return rec
    }

    private fun invalidateHttpsRecord(host: String) {
        httpsRecordCache.remove(host)
    }

    /**
     * 用 DoH 解析域名，失败返回空列表。
     *
     * **优先用 HTTPS 记录里的 ipv4hint/ipv6hint** —— 它与 ECH 配置来自同一次查询、
     * 同一批国内可达的纯 IP（实测 158ms 成功）。
     *
     * 为什么改掉原实现：原实现一律走 `dohResolver`（OkHttp DnsOverHttps → 自有网关，
     * 钉 162.159.36.x）。实测用户网络下那条路连不上 —— 日志里每次卡 17~21 秒后
     * `0 个地址 → fail-closed`，而**同一时刻** ech.fetch 走国内三家 158ms 就成功了。
     * 于是 ECH 配置拿得到、IP 却解析不出来，整个链路仍然 fail-closed。
     *
     * 自有网关退为兜底：它仍有价值（能拿到不受污染的结果），但不能是唯一路径。
     */
    fun resolve(host: String): List<InetAddress> {
        // ① HTTPS 记录的地址提示（与 ECH 同源、同一次查询、国内可达）
        runCatching {
            val rec = httpsRecord(host)
            if (rec != null) {
                val addrs = (rec.ipv4 + rec.ipv6)
                    .mapNotNull { ip -> runCatching { InetAddress.getByName(ip) }.getOrNull() }
                    .filter { !it.isAnyLocalAddress && !it.isLoopbackAddress }
                if (addrs.isNotEmpty()) {
                    Diagnostics.trace(
                        "net.resolve.hint",
                        mapOf(
                            "host" to host, "n" to addrs.size,
                            "ips" to addrs.joinToString(",") { it.hostAddress ?: "?" }
                        )
                    )
                    return addrs
                }
            }
        }

        // ② 兜底：自有网关（防污染）。bootstrap IP 由种子层动态解析而来。
        return try {
            val addrs = dohResolver().lookup(host)
            Log.i(TAG, "doh resolve $host -> ${addrs.joinToString { it.hostAddress ?: "?" }}")
            Diagnostics.trace(
                "net.resolve.gateway",
                mapOf("host" to host, "n" to addrs.size,
                      "ips" to addrs.joinToString(",") { it.hostAddress ?: "?" })
            )
            addrs
        } catch (t: Throwable) {
            Log.w(TAG, "doh resolve failed for $host: ${t.message}")
            Diagnostics.trace(
                "net.resolve.fail",
                mapOf("host" to host, "err" to "${t.javaClass.simpleName}: ${t.message}")
            )
            // 网关可能换了地址或当前 IP 不可达 —— 丢缓存，下次重新向国内 DoH 问「网关在哪」。
            invalidateGateway()
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
