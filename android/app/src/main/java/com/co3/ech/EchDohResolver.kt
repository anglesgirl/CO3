package com.co3.ech

import android.util.Log
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * 用 DoH 的 DNS JSON 接口（`?name=<host>&type=65` + `accept: application/dns-json`）
 * 查目标的 ECHConfigList 与直连地址。
 *
 * 这是 ech_http C++ 引擎**不提供**的那一半：引擎只吃 `ech_config` + `connect_ip`
 * 两个入参，怎么把它们取到手是宿主自己的事。规则与 ech_http 的 Dart 参考实现
 * （DohEchResolver）以及现有 Go 侧保持一致，方便对照排查。
 *
 * 为什么必须有 DoH：目标域名的系统解析会被污染，而 `connect_ip` 一旦为空，
 * 引擎就会走系统解析 → 连到假地址。所以这里是 fail-closed 的：拿不到地址就
 * 抛错，绝不放行一次没有地址约束的请求。
 */
object EchDohResolver {
    private const val TAG = "CO3-ECHHTTP"
    private const val DEFAULT_TIMEOUT_MS = 8000L

    /** CF 侧 ECH 配置约 5 小时轮换，缓存上限与之一致。 */
    private const val MAX_CACHE_AGE_MS = 5L * 60 * 60 * 1000

    private const val HTTPS_RECORD_TYPE = 65
    private const val A_RECORD_TYPE = 1

    private val ECH_RE = Regex("""(?:^|\s)ech="?([A-Za-z0-9+/=]+)""")
    private val IPV4_HINT_RE = Regex("""(?:^|\s)ipv4hint="?([0-9.,]+)""")
    private val IPV6_HINT_RE = Regex("""(?:^|\s)ipv6hint="?([0-9a-fA-F:.,]+)""")

    /** 一次解析的结果。 */
    data class Route(
        /** Base64 的 ECHConfigList（不含引号），直接喂给引擎的 ech_config。 */
        val echConfig: String,
        /** 直连地址，按优先级排列；非空（为空即抛错）。 */
        val addresses: List<String>,
        /** 生效的 TTL（秒），顶层取 min(记录 TTL, 缓存上限)。 */
        val ttlSeconds: Long,
        /** ECH 配置的来源域名——借用他人配置时会与目标域名不同。 */
        val configHost: String,
    )

    private data class Entry(val route: Route, val expiresAtMs: Long)

    private val cache = ConcurrentHashMap<String, Entry>()
    private val inflight = ConcurrentHashMap<String, Any>()

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    fun clearCache() = cache.clear()

    /**
     * 解析 [host]。
     *
     * @param dohEndpoints DoH 端点列表（逗号分隔的字符串请先用 [splitEndpoints] 拆开），
     *   按顺序尝试，第一个可用者胜出。
     * @param addressOverrides 用户配置的优选 IP。非空时**优先于** ipv4hint ——
     *   ipv4hint 是 CF 给的建议地址，优选 IP 才是本机实测更好的入口。
     * @param configHost 借用哪个域名的 ECH 配置（如 cloudflare-ech.com）。默认用
     *   [host] 自己发的记录；借用时**不采用**借来记录里的 ipv4hint，因为那是
     *   对方域名的地址，对目标域名无效。
     */
    fun resolve(
        host: String,
        dohEndpoints: List<String>,
        addressOverrides: List<String> = emptyList(),
        configHost: String? = null,
    ): Route {
        val target = host.lowercase()
        cache[target]?.let { if (it.expiresAtMs > System.currentTimeMillis()) return it.route }

        val endpoints = dohEndpoints.map { it.trim() }.filter { it.isNotEmpty() }
        if (endpoints.isEmpty()) throw IOException("未配置 DoH 端点（fail-closed，不放行无地址约束的请求）")

        val borrowed = configHost?.lowercase()?.takeIf { it.isNotEmpty() && it != target }
        val queryHost = borrowed ?: target

        var lastError: Exception? = null
        for (endpoint in endpoints) {
            try {
                return resolveVia(endpoint, target, queryHost, borrowed != null, addressOverrides)
                    .also { cache[target] = Entry(it, System.currentTimeMillis() + it.ttlSeconds * 1000) }
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "DoH 解析失败 via $endpoint: ${e.message}")
            }
        }
        throw IOException("全部 DoH 端点都失败：${lastError?.message}", lastError)
    }

    private fun resolveVia(
        endpoint: String,
        host: String,
        configHost: String,
        borrowed: Boolean,
        addressOverrides: List<String>,
    ): Route {
        val answer = queryJson(endpoint, configHost, HTTPS_RECORD_TYPE)

        var echConfig: String? = null
        var ttlSeconds = MAX_CACHE_AGE_MS / 1000
        val hints = mutableListOf<String>()

        for (record in answer) {
            if (record.optInt("type") != HTTPS_RECORD_TYPE) continue
            val data = record.optString("data", "")
            if (data.isEmpty()) continue
            val ech = ECH_RE.find(data)?.groupValues?.get(1)
            if (ech == null) continue
            echConfig = ech
            ttlSeconds = minOf(ttlSeconds, record.optLong("TTL", 0L))
            // 借来的配置只能取 ech 值：它的 ipv4hint 指向对方域名，对目标无效
            if (!borrowed) {
                IPV4_HINT_RE.find(data)?.groupValues?.get(1)
                    ?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
                    ?.let { hints.addAll(it) }
                IPV6_HINT_RE.find(data)?.groupValues?.get(1)
                    ?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
                    ?.let { hints.addAll(it) }
            }
            break
        }

        if (echConfig == null) {
            throw IOException("$configHost 没有发布 ECHConfigList（fail-closed，拒绝明文）")
        }

        var addresses = addressOverrides.filter { it.isNotBlank() }
        if (addresses.isEmpty()) addresses = hints
        if (addresses.isEmpty()) {
            // 目标自己没给 hints（借用配置时必然如此）→ 单独查 A 记录
            val aRecords = queryJson(endpoint, host, A_RECORD_TYPE)
            addresses = aRecords.mapNotNull { r ->
                if (r.optInt("type") == A_RECORD_TYPE) r.optString("data", "").takeIf { it.isNotEmpty() } else null
            }
            aRecords.firstOrNull { r -> r.optInt("type") == A_RECORD_TYPE }
                ?.let { ttlSeconds = minOf(ttlSeconds, it.optLong("TTL", 0L)) }
        }
        if (addresses.isEmpty()) throw IOException("$host 没有可用地址（fail-closed）")

        return Route(echConfig, addresses, ttlSeconds, configHost)
    }

    /** 查一次 DNS JSON，返回 Answer 数组；Status != 0 视为失败。 */
    private fun queryJson(endpoint: String, name: String, type: Int): List<JSONObject> {
        val url = endpoint.toHttpUrlOrNull()?.newBuilder()
            ?.setQueryParameter("name", name)
            ?.setQueryParameter("type", type.toString())
            ?.build()
            ?: throw IOException("DoH 端点不是合法 URL: $endpoint")

        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/dns-json")
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("DoH HTTP ${response.code}")
            val body = response.body?.string() ?: throw IOException("DoH 空应答")
            val json = JSONObject(body)
            if (json.optInt("Status", -1) != 0) {
                throw IOException("DoH 返回 Status=${json.optInt("Status", -1)}")
            }
            val arr = json.optJSONArray("Answer") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
        }
    }

    /** 把 `a,b,c` 拆成端点列表（JS 侧就是逗号拼接的）。 */
    fun splitEndpoints(raw: String?): List<String> =
        raw?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
}
