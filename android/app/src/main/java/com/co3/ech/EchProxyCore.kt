package com.co3.ech

import android.content.Context
import android.util.Log
import android.webkit.CookieManager
import echproxy.Echproxy
import java.net.ServerSocket
import java.net.Socket

/**
 * Go ECH 代理运行时（Android，同进程内嵌）。
 *
 * 【来源】安卓回迁 Go（用户拍板）：苹果端与安卓端统一用 `ech/echproxy.go`
 * （gomobile bind 出的 aar），不再维护 Conscrypt 那套独立 ECH 实现。
 * Go 库通过 JNI 跑在 App 自身进程内（非独立子进程）——不存在"单独 Go
 * 进程被系统回收"的问题；App 存活即代理存活。
 *
 * 【职责】
 *  - 幂等启动 Go 代理（127.0.0.1:<port>，端口自动选择，撞 already running
 *    先 Stop 再 Start——镜像 iOS EchProxyModule.swift 的防竞态逻辑）
 *  - 状态/日志/cookie jar 的透传（status/drainLogs/jarInfo/clearSessionCookies/fetchTxt）
 *  - 把 Go jar 里的 AO3 域 cookie 同步进 CookieManager：WebView 收的是改写后
 *    的 127.0.0.1 域 cookie（页面 origin），但登录态判据
 *    （hasUserCredentials / 登录成功检测）读 CookieManager 的 AO3 域——
 *    页面加载后同步一次，登录态即可正常识别。
 *
 * 不依赖 RN（MainApplication 启动时即可调用）；Go aar 由 CI 的 gomobile
 * 步骤生成（见 android-build.yml）。
 */
object EchProxyCore {
    private const val TAG = "CO-ECHPROXY"
    const val TARGET = "archiveofourown.org"

    /** Application 注入的 context（拿 cacheDir 存 ECH 配置缓存）。 */
    @Volatile var appContext: Context? = null

    @Volatile
    private var runningPort = 0
    private val lock = Any()

    // 当前实例实际生效的配置。Go 侧只在 Start() 时读一次 doh/ipList（存进
    // activeDoH），此后无法更新 —— 所以配置变了必须重启，否则新配置永远不会
    // 生效。详见 ensureStarted 里的说明。
    // 轻量事件环（诊断可见）。"谁重启了代理""cookie 到底写进去几条"这类问题，
    // 光看 Go 侧日志和 JS console 都拼不出因果 —— 因为重启是 Kotlin 侧发起的。
    private const val EVENT_KEEP = 60
    private val events = ArrayDeque<String>()

    /** 记一条事件（JVM monitor 可重入，在 synchronized(lock) 内调用也安全）。 */
    fun note(msg: String) {
        synchronized(lock) {
            events.addLast("${System.currentTimeMillis()} $msg")
            while (events.size > EVENT_KEEP) events.removeFirst()
        }
    }

    /** 取走并清空事件环（诊断导出用）。 */
    fun drainEvents(): String = synchronized(lock) {
        if (events.isEmpty()) return ""
        val out = events.joinToString("\n")
        events.clear()
        out
    }

    @Volatile
    private var activeDoh = ""

    @Volatile
    private var activeIpList = ""

    val isRunning: Boolean get() = runningPort != 0 && isListening(runningPort)
    val port: Int get() = runningPort
    val baseUrl: String get() = "http://127.0.0.1:$runningPort"

    /** 幂等启动：已在跑直接复用端口；port=0 自动选空闲端口。返回实际端口，失败 0。 */
    fun ensureStarted(port: Int, doh: String, ipList: String): Int {
        synchronized(lock) {
            if (runningPort != 0 && isListening(runningPort)) {
                if (doh == activeDoh && ipList == activeIpList) return runningPort
                // 配置变了 —— 必须重启。曾经这里只比端口就复用，于是
                // MainApplication 用默认空参数抢跑（LocalEchProxy.start() 的
                // doh/ipList 默认是空串）之后，JS 带着正确 DoH 再启动时被幂等
                // 短路，Go 侧 activeDoH 永远是空 → DoH 全程失效，只能靠种子 IP
                // 兜底，种子失效时直接 fail-closed 断网（2026-09-29 真机诊断实证）。
                Log.i(
                    TAG,
                    "ECH 配置变更，重启代理：doh=[$activeDoh] -> [$doh]；ip=[$activeIpList] -> [$ipList]",
                )
                note("配置变更 → 重启：doh=[${activeDoh.take(60)}] -> [${doh.take(60)}]；ip=[$activeIpList] -> [$ipList]")
                runCatching { Echproxy.stop() }
                runningPort = 0
            }
            val chosen = if (port != 0) port else freePort()
            if (chosen == 0) return 0
            val listen = "127.0.0.1:$chosen"
            val cache = appContext?.cacheDir?.absolutePath?.let { "$it/ech-public-config.json" } ?: ""
            try {
                // gomobile: func Start(listen, target, echB64, doh, ipList, cpArg string, insecure bool) error
                Echproxy.start(listen, TARGET, "", doh, ipList, cache, false)
            } catch (e: Exception) {
                if (e.message?.contains("already running", ignoreCase = true) == true) {
                    // 旧实例端口未知（JS 重载/重启竞态）→ 停掉重启，比整个 App 断网好。
                    runCatching { Echproxy.stop() }
                    try {
                        Echproxy.start(listen, TARGET, "", doh, ipList, cache, false)
                    } catch (e2: Exception) {
                        Log.w(TAG, "restart failed: ${e2.message}")
                        return 0
                    }
                } else {
                    Log.w(TAG, "start failed: ${e.message}")
                    return 0
                }
            }
            runningPort = chosen
            activeDoh = doh
            activeIpList = ipList
            Log.i(TAG, "ECH proxy listening on http://127.0.0.1:$chosen")
            return chosen
        }
    }

    // ==================== 配置持久化（消灭启动空窗） ====================
    //
    // 背景（2026-09-30 真机日志）：MainApplication 在 App 启动时调用
    // LocalEchProxy.start()（无参数 → 空 DoH），建出一个解析不到任何地址的代理；
    // 而 JS 侧要 55 秒后才带着真实 DoH 调 start()，此时幂等短路又会复用那个坏代理。
    // 结果这 55 秒里 host ready (0 addr(s))，所有请求 502。
    // 解法：JS 每次 start 都把配置落盘，App 下次冷启动直接读回来 —— 启动即用正确
    // 配置；从未落盘（首次安装）就不启动，交给 JS 首次调用。
    private const val PREFS_NAME = "co3_ech_proxy"
    private const val KEY_DOH = "doh"
    private const val KEY_IP_LIST = "ip_list"

    fun saveConfigPrefs(context: android.content.Context, doh: String, ipList: String) {
        runCatching {
            context.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_DOH, doh)
                .putString(KEY_IP_LIST, ipList)
                .apply()
        }.onFailure { android.util.Log.w("CO-ECH", "saveConfigPrefs failed: ${it.message}") }
    }

    /** @return (doh, ipList)；从未保存过时两者都是空串。 */
    fun loadSavedConfig(context: android.content.Context): Pair<String, String> =
        runCatching {
            val sp = context.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
            (sp.getString(KEY_DOH, "") ?: "") to (sp.getString(KEY_IP_LIST, "") ?: "")
        }.getOrElse { "" to "" }

    fun stop() {
        synchronized(lock) {
            note("stop() 被调用（JS restartProxy / 登出清理都会走这里）")
            runCatching { Echproxy.stop() }
            runningPort = 0
            activeDoh = ""
            activeIpList = ""
        }
    }

    fun lastStatus(): String = runCatching { Echproxy.lastStatus() }.getOrDefault("")
    fun drainLogs(): String = runCatching { Echproxy.drainLogs() }.getOrDefault("")
    fun jarInfo(): String = runCatching { Echproxy.jarInfo() }.getOrDefault("")
    fun clearSessionCookies() = runCatching { Echproxy.clearSessionCookies() }
    fun fetchTxt(doh: String, name: String): String =
        runCatching { Echproxy.fetchTxt(doh, name) }.getOrDefault("")

    fun isListening(port: Int): Boolean = try {
        Socket("127.0.0.1", port).use { true }
    } catch (e: Exception) {
        false
    }

    fun freePort(): Int = try {
        ServerSocket(0).use { it.localPort }
    } catch (e: Exception) {
        0
    }

    // 单行形如：
    //   user_credentials="xxx" domain="archiveofourown.org" path="/" secure=true maxAge=0
    private val COOKIE_LINE =
        Regex("""^\s*([^=\s"]+)="([^"]*)" domain="([^"]*)" path="([^"]*)" secure=(\w+) maxAge=(-?\d+)""")

    /**
     * 把 Go jar 里的 AO3 域 cookie 同步进 CookieManager（AO3 域）。
     * 页面加载后调用（EchWebViewManager.onPageFinished）；幂等，可反复调。
     */
    fun syncCookiesToCookieManager() {
        val info = jarInfo()
        if (info.isBlank() || info.startsWith("jar: nil") || info == "jar: empty") return
        val cm = CookieManager.getInstance()
        var parsed = 0
        var written = 0
        var fallback = 0
        for (line in info.split('\n')) {
            val m = COOKIE_LINE.find(line) ?: continue
            parsed++
            val name = m.groupValues[1]
            val value = m.groupValues[2]
            val domain = m.groupValues[3]
            val path = m.groupValues[4]
            val secure = m.groupValues[5].equals("true", ignoreCase = true)
            if (name.isBlank()) continue
            // AO3 的 Set-Cookie 不带 Domain 属性 → Go jar 里 Domain 为空。
            // 原先这里直接 !domain.contains(TARGET) 就 continue，结果**所有**
            // cookie 都被跳过（2026-09-30 真机诊断里每行都是 domain=""），
            // CookieManager 拿不到任何登录态，App 表现为"登录成功了但界面仍是
            // 未登录"。domain 为空时按目标域名兜底。
            val effectiveDomain = domain.ifBlank { TARGET }
            if (domain.isBlank()) fallback++
            if (!effectiveDomain.contains(TARGET)) continue
            val sb = StringBuilder()
            sb.append(name).append('=').append(value)
            if (domain.isNotEmpty()) sb.append("; Domain=").append(domain)
            if (path.isNotEmpty()) sb.append("; Path=").append(path)
            if (secure) sb.append("; Secure")
            try {
                // 用兜底域名，否则 URL 会变成 "https://" 而 setCookie 直接失败
                cm.setCookie("https://$effectiveDomain/", sb.toString())
                written++
            } catch (_: Exception) {}
        }
        cm.flush()
        if (parsed > 0) {
            note("cookie 同步：解析 $parsed 行，写入 $written 条（domain 为空兜底 $fallback 条）")
        }
    }
}
