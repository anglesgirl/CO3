package com.co3.ech

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * RN 桥：`NativeModules.EchHttp`。
 *
 * 把 Conscrypt ECH 引擎（进程内 OkHttp + BoringSSL，2026-10-02 起替代 kathttp3/H3）暴露给 JS：
 *   request(url, method, headers, doh, connectIp, configHost, timeoutMs) -> Promise<响应>
 *   probeDoh(host, doh, configHost) -> Promise<解析结果>
 *   status() -> Promise<{available, version}>
 *
 * 与 EchProxy 的关键区别：**没有本地端口**。引擎是命令式调用的 HTTP 客户端，
 * 请求在调用线程上同步完成，不需要 127.0.0.1 转发，也就没有"代理没起来 /
 * 配置没生效 / 端口对不上"这一整类问题。
 *
 * 职责划分（刻意如此）：DoH（[EchDoh]，直查自有网关）+ 引擎调用（[EchEngineClient]）
 * 都在本模块串起来，JS 侧只负责提供 DoH 端点 —— 配置的权威仍是 JS
 * （设置页写 AsyncStorage），避免出现"两处配置各说各话"。
 */
class EchHttpModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule() {

    override fun getName() = "EchHttp"

    init {
        // WebView 拦截路径（CoWebViewHelper）拿不到 Context，但需要读 DoH 配置，
        // 所以在这里把 applicationContext 交给 EchDohConfig（用 app context，不泄漏 Activity）。
        EchDohConfig.appContext = ctx.applicationContext
    }

    /**
     * 落盘 DoH 配置，供 WebView 拦截路径（CoWebViewHelper）使用。
     *
     * 引擎自己不查 DoH，只接受 echConfig + connectIp；而端点权威在 JS（AsyncStorage）。
     * JS 在 initEch 时调用本方法存一份，改 DoH 的设置页也应重调。
     */
    @ReactMethod
    fun setDohConfig(doh: String, configHost: String, ipList: String, promise: Promise) {
        try {
            EchDohConfig.save(ctx, doh, configHost, ipList)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ECH_DOH_CONFIG_SAVE_FAILED", e.message ?: "unknown", e)
        }
    }

    private val io: ExecutorService = Executors.newSingleThreadExecutor()

    private val LOG_TAG = "CO3-ECHHTTP"

    /** 引擎是否随包投放且能加载，以及版本串。用于诊断与灰度判断。 */
    @ReactMethod
    fun status(promise: Promise) {
        try {
            val map = Arguments.createMap()
            map.putBoolean("available", ConscryptEch.install())
            map.putString("version", "conscrypt/" + org.conscrypt.Conscrypt.version())
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("ECH_STATUS_FAILED", e.message ?: "unknown", e)
        }
    }

    /**
     * 清 AO3 的 cookie（登出走这里）。
     *
     * 引擎零 cookie 代码，cookie 权威在 CookieManager，所以登出就是清它。
     * @param keepCf true = 保留 Cloudflare 的 cf_clearance/__cf_bm/_cfuvid
     *   （清 session 而非登出，避免把用户刚过的 CF 验证作废）。
     */
    @ReactMethod
    fun clearCookies(keepCf: Boolean, promise: Promise) {
        try {
            val cm = android.webkit.CookieManager.getInstance()
            val url = "https://archiveofourown.org/"
            val raw = cm.getCookie(url) ?: ""
            val names = raw.split(';').mapNotNull { it.substringBefore('=').trim().ifEmpty { null } }
            var removed = 0
            for (name in names) {
                if (keepCf && (name == "cf_clearance" || name == "__cf_bm" || name == "_cfuvid")) continue
                cm.setCookie(url, "$name=; Max-Age=0; path=/")
                removed++
            }
            cm.flush()
            promise.resolve(removed)
        } catch (e: Exception) {
            promise.reject("ECH_CLEAR_COOKIES_FAILED", e.message ?: "unknown", e)
        }
    }

    /** 当前 AO3 cookie 摘要（诊断用；只报名字与长度，不返回凭证值）。 */
    @ReactMethod
    fun cookieSummary(promise: Promise) {
        try {
            val raw = android.webkit.CookieManager.getInstance()
                .getCookie("https://archiveofourown.org/") ?: ""
            val parts = raw.split(';').map { it.trim() }.filter { it.isNotEmpty() }
            val map = Arguments.createMap()
            map.putInt("count", parts.size)
            map.putBoolean("hasSession", raw.contains("_otwarchive_session"))
            map.putBoolean("hasCreds", raw.contains("user_credentials"))
            map.putString("names", parts.map { it.substringBefore('=') }.joinToString(","))
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("ECH_COOKIE_SUMMARY_FAILED", e.message ?: "unknown", e)
        }
    }

    /**
     * 只做 DoH 解析，不发起 TLS。
     * 用于把"取不到 ECH 配置"和"ECH 握手失败"这两类问题分开定位。
     */
    @ReactMethod
    fun probeDoh(host: String, doh: String, configHost: String, promise: Promise) {
        io.execute {
            try {
                val t0 = System.currentTimeMillis()
                // 诊断工具：直查目标域名自己的 HTTPS 记录（网关），不经过借用逻辑
                val rec = EchDoh.record(host)
                    ?: throw java.io.IOException("网关未返回 $host 的 HTTPS 记录")
                val addrs = EchDoh.resolve(host)
                val map = Arguments.createMap()
                map.putInt("ms", (System.currentTimeMillis() - t0).toInt())
                map.putInt("echBytes", rec.ech?.size ?: 0)
                map.putString("configHost", host)
                map.putString("connectIp", addrs.firstOrNull()?.hostAddress ?: "")
                map.putInt("addressCount", addrs.size)
                map.putDouble("ttlSeconds", (rec.ttlMs / 1000).toDouble())
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("ECH_DOH_FAILED", e.message ?: "unknown", e)
            }
        }
    }

    /**
     * 完整请求：DoH 取 ECH 配置与地址 → C++ 引擎做 ECH 握手 → 返回响应。
     *
     * 阻塞式（在 io 队列上跑），JS 侧拿到的是一次完整响应。**fail-closed**：
     * DoH 拿不到 ECH 配置或地址就直接 reject，绝不退化成明文请求。
     *
     * @param doh 逗号分隔的 DoH 端点（与设置页/echKy.js 同一份来源）
     * @param connectIp 逗号分隔的优选 IP；非空时优先于 ipv4hint
     * @param configHost 借用哪个域名发的 ECH 配置；空 = 用目标自己的记录
     */
    @ReactMethod
    fun request(
        url: String,
        method: String,
        headers: String,
        body: String,
        doh: String,
        connectIp: String,
        configHost: String,
        timeoutMs: Double,
        promise: Promise,
    ) {
        io.execute {
            if (!ConscryptEch.install()) {
                promise.reject("ECH_ENGINE_UNAVAILABLE", "Conscrypt 初始化失败")
                return@execute
            }
            val t0 = System.currentTimeMillis()
            try {
                val host = URL(url).host ?: throw IllegalArgumentException("URL 缺少主机名: $url")

                // ① 注入 CookieManager 的 cookie —— 这一步不能省。
                //    JS 侧（echEngineFetch）刻意把 cookie 交给"原生侧统一注入"，
                //    但这里一直没实现，导致 JS 路径全是匿名请求：AO3 认不出会话，
                //    也更容易被 CF 拦。真机实证：同样走引擎，WebView 那条因为带了
                //    cookie 大量 200，而这条 /works 持续 525。
                val cookieHeader = runCatching {
                    android.webkit.CookieManager.getInstance().getCookie(url)
                }.getOrNull().orEmpty()
                val effectiveHeaders = if (
                    cookieHeader.isNotEmpty() &&
                    !headers.lineSequence().any { it.startsWith("Cookie:", ignoreCase = true) }
                ) {
                    if (headers.isEmpty()) "Cookie: $cookieHeader"
                    else headers + "\r\nCookie: $cookieHeader"
                } else {
                    headers
                }

                val bodyBytes = body.takeIf { it.isNotEmpty() }?.toByteArray(Charsets.UTF_8)
                val totalMs = timeoutMs.toLong().takeIf { it > 0 } ?: 30_000L

                // ⚠️ 2026-10-01：JS 路径改走 EchEngineClient（与 WebView 路径完全同构）。
                // 此前 JS 路径用自己的 resolve+候选循环，与 WebView 路径（EchEngineClient）
                // 在配置来源/候选选择/失败处理上存在差异，真机日志实证：WebView 全部
                // 200（ech=true 毫秒级），JS 路径同一时段 /works 先 525、重试全超时。
                // EchEngineClient 已被 WebView 路径证明可用，统一后两条路径行为一致；
                // 其内部使用落盘 DoH 配置（JS setDoh 双写同步，空时默认兜底），
                // 不再使用 JS 传入的 doh/connectIp 参数（保留签名兼容 JS 调用方）。
                // 诊断：成功/失败事件（engine_ok / engine_fail）在 EchEngineClient 内上报，
                // 带候选 IP 列表与失败原因 —— 服务器统计可按 IP 定位。
                val resp = EchEngineClient.request(
                    host = host,
                    url = url,
                    method = method.ifBlank { "GET" },
                    headers = effectiveHeaders,
                    body = bodyBytes,
                    totalTimeoutMs = totalMs,
                )

                // ② Set-Cookie 写回 CookieManager —— 否则 JS 路径拿到的会话
                //    cookie 只活在这次响应里，下个请求又是匿名的。
                //    EchEngineClient.request 成功即返回非空响应，这里无需判空。
                runCatching {
                    val cm = android.webkit.CookieManager.getInstance()
                    resp.headers.split("\r\n", "\n").forEach { line ->
                        val idx = line.indexOf(':')
                        if (idx <= 0) return@forEach
                        if (!line.substring(0, idx).trim().equals("Set-Cookie", true)) return@forEach
                        var fixed = line.substring(idx + 1).trim()
                        fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                        fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                        fixed = fixed.replace(Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE), "; SameSite=Lax")
                        cm.setCookie(url, fixed)
                        if (line.contains("user_credentials") || line.contains("_otwarchive_session")) {
                            runCatching { cm.setCookie("https://archiveofourown.org/", fixed) }
                        }
                    }
                    cm.flush()
                }.onFailure {
                    com.co3.Diagnostics.event("js_cookie_writeback_fail", mapOf("err" to (it.message ?: "")))
                }

                val map = Arguments.createMap()
                map.putInt("status", resp.status)
                map.putString("headers", resp.headers)
                map.putString("body", String(resp.body, Charsets.UTF_8))
                map.putBoolean("echAccepted", resp.echAccepted)
                map.putInt("echRetries", resp.echRetries)
                map.putString("totalMs", (System.currentTimeMillis() - t0).toString())
                promise.resolve(map)
            } catch (e: Exception) {
                Log.w(LOG_TAG, "EchHttp.request 失败: ${e.message}")
                promise.reject("ECH_HTTP_FAILED", e.message ?: "unknown", e)
            }
        }
    }
}
