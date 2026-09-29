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

    fun stop() {
        synchronized(lock) {
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
        for (line in info.split('\n')) {
            val m = COOKIE_LINE.find(line) ?: continue
            val name = m.groupValues[1]
            val value = m.groupValues[2]
            val domain = m.groupValues[3]
            val path = m.groupValues[4]
            val secure = m.groupValues[5].equals("true", ignoreCase = true)
            if (name.isBlank() || !domain.contains(TARGET)) continue
            val sb = StringBuilder()
            sb.append(name).append('=').append(value)
            if (domain.isNotEmpty()) sb.append("; Domain=").append(domain)
            if (path.isNotEmpty()) sb.append("; Path=").append(path)
            if (secure) sb.append("; Secure")
            try {
                cm.setCookie("https://$domain/", sb.toString())
            } catch (_: Exception) {}
        }
        cm.flush()
    }
}
