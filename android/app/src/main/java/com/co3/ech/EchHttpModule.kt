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
 * 把 ech_http 的 C++ 引擎（去 Dart 化后编进 libco3ech.so）暴露给 JS：
 *   request(url, method, headers, doh, connectIp, configHost, timeoutMs) -> Promise<响应>
 *   probeDoh(host, doh, configHost) -> Promise<解析结果>
 *   status() -> Promise<{available, version}>
 *
 * 与 EchProxy 的关键区别：**没有本地端口**。引擎是命令式调用的 HTTP 客户端，
 * 请求在调用线程上同步完成，不需要 127.0.0.1 转发，也就没有"代理没起来 /
 * 配置没生效 / 端口对不上"这一整类问题。
 *
 * 职责划分（刻意如此）：DoH 解析（[EchDohResolver]）+ 引擎调用（[EchHttpNative]）
 * 都在本模块串起来，JS 侧只负责提供 DoH 端点与优选 IP —— 配置的权威仍是 JS
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
            map.putBoolean("available", EchHttpNative.isAvailable)
            map.putString("version", EchHttpNative.version)
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
                val route = EchDohResolver.resolve(
                    host = host,
                    dohEndpoints = EchDohResolver.splitEndpoints(doh),
                    addressOverrides = emptyList(),
                    configHost = configHost.takeIf { it.isNotBlank() },
                )
                val map = Arguments.createMap()
                map.putInt("ms", (System.currentTimeMillis() - t0).toInt())
                map.putInt("echBytes", route.echConfig.length)
                map.putString("configHost", route.configHost)
                map.putString("connectIp", route.addresses.firstOrNull() ?: "")
                map.putInt("addressCount", route.addresses.size)
                map.putDouble("ttlSeconds", route.ttlSeconds.toDouble())
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
            if (!EchHttpNative.isAvailable) {
                promise.reject("ECH_ENGINE_UNAVAILABLE", "libco3ech.so 未加载")
                return@execute
            }
            val t0 = System.currentTimeMillis()
            try {
                val host = URL(url).host ?: throw IllegalArgumentException("URL 缺少主机名: $url")
                val route = EchDohResolver.resolve(
                    host = host,
                    dohEndpoints = EchDohResolver.splitEndpoints(doh),
                    addressOverrides = EchDohResolver.splitEndpoints(connectIp),
                    configHost = configHost.takeIf { it.isNotBlank() },
                )
                val dohMs = System.currentTimeMillis() - t0

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

                // 逐个尝试候选地址：国内到不同 CF IP 段可达性差异极大，
                // 只试第一个（旧写法）会时不时整条链路失败。总预算按候选数均分。
                val bodyBytes = body.takeIf { it.isNotEmpty() }?.toByteArray(Charsets.UTF_8)
                val totalMs = timeoutMs.toLong().takeIf { it > 0 } ?: 30_000L
                val perTry = (totalMs / route.addresses.size.coerceAtLeast(1)).coerceAtLeast(3_000L)
                var result: EchHttpNative.Response? = null
                var target = ""
                var lastErr: Exception? = null
                for (ip in route.addresses) {
                    target = ip
                    try {
                        val r = EchHttpNative.request(
                            url = url,
                            method = method.ifBlank { "GET" },
                            headers = effectiveHeaders,
                            // POST 表单等；GET 时 JS 传空串 → null（引擎按无请求体处理）
                            body = bodyBytes,
                            echConfig = route.echConfig,
                            connectIp = ip,
                            timeoutMs = perTry,
                            maxResponseBytes = 32L * 1024 * 1024,
                        )
                        if (r != null && r.status != 0) {
                            result = r
                            break
                        }
                        lastErr = IllegalStateException("地址 $ip 未取得响应（ECH 被拒或超时）")
                    } catch (e: Exception) {
                        lastErr = e
                    }
                    Log.w(LOG_TAG, "候选地址 $ip 失败，尝试下一个")
                }

                // ② Set-Cookie 写回 CookieManager —— 否则 JS 路径拿到的会话
                //    cookie 只活在这次响应里，下个请求又是匿名的。
                runCatching {
                    // result 为 null 时（所有候选地址都失败）没有响应头可写，直接跳过。
                    val r = result ?: return@runCatching
                    val cm = android.webkit.CookieManager.getInstance()
                    r.headers.split("\r\n", "\n").forEach { line ->
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

                if (result == null) {
                    // 所有候选都不行。不降级明文 —— fail-closed。
                    promise.reject(
                        "ECH_ENGINE_REQUEST_FAILED",
                        lastErr?.message
                            ?: "所有候选地址都失败（共 ${route.addresses.size} 个；fail-closed 未降级明文）",
                    )
                    return@execute
                }

                val map = Arguments.createMap()
                map.putInt("status", result.status)
                map.putString("headers", result.headers)
                map.putString("body", String(result.body, Charsets.UTF_8))
                map.putBoolean("echAccepted", result.echAccepted)
                map.putInt("echRetries", result.echRetries)
                map.putString("connectIp", target)
                map.putString("configHost", route.configHost)
                map.putInt("dohMs", dohMs.toInt())
                map.putInt("totalMs", (System.currentTimeMillis() - t0).toInt())
                promise.resolve(map)
            } catch (e: Exception) {
                Log.w(LOG_TAG, "EchHttp.request 失败: ${e.message}")
                promise.reject("ECH_HTTP_FAILED", e.message ?: "unknown", e)
            }
        }
    }
}
