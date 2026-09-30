package com.co3.ech

import android.util.Log

/**
 * 本地 ECH 代理门面（Android）。
 *
 * 【架构变迁】安卓回迁 Go（用户拍板：苹果端与安卓端统一用 Go ECH 代理）：
 * 曾经的进程内 OkHttp+Conscrypt 转发服务（LocalHttpServer）已移除，
 * 转发由 `ech/echproxy.go`（gomobile aar，同进程内嵌）负责——
 * Kotlin 侧只保留 WebView 需要的端口门面与 URL 改写。
 *
 * 职责（本文件）：
 *  - start()/stop()：委托 EchProxyCore（Go 运行时，幂等、自动选端口）
 *  - port/baseUrl：供 EchWebViewManager / injectLocalRewrite 拼本地代理地址
 *  - rewriteWebUrl()：把 https://archiveofourown.org 页面地址改写成 http://127.0.0.1:<port>（路径原样保留）
 *    （EchWebView 加载页面的唯一入口，改写的页面流量全走 Go 代理 + ECH）
 *
 * WebView 子请求（图片/脚本等）由 CoWebViewHelper.intercept 拦截后同样走
 * 本地 Go 代理（见该文件注释）。JS 侧（echKy.js）走 NativeModules.EchProxy
 * 拿端口后 fetch 本地代理 —— 双端同一套逻辑。
 */
object LocalEchProxy {
    private const val TAG = "CO-LOCALPROXY"

    const val DEFAULT_PORT = 8080
    private const val HOST = "archiveofourown.org"

    val isRunning: Boolean get() = EchProxyCore.isRunning

    @Volatile
    var port: Int = DEFAULT_PORT
        private set

    val baseUrl: String get() = "http://127.0.0.1:$port"

    /**
     * 幂等启动 Go 代理（同进程 gomobile aar，非独立进程）。
     * port=0 自动选空闲端口；已在跑直接复用。成功返回 true。
     */
    fun start(doh: String = "", ipList: String = ""): Boolean {
        // ⚠️ 无参调用（WebView 的幂等确保路径：CoWebViewHelper / EchWebViewManager）
        // 曾经把代理重启成空 DoH：默认参数是空串 → ensureStarted 发现 ""≠当前配置，
        // 走「配置变更」分支重启，Go 侧 activeDoH 被写成空 → 加载登录页的那一瞬间
        // 代理就从「4 DoH address(es)」掉成「no DoH endpoint configured」，请求全 502
        // （2026-09-30 真机日志实证）。
        // 这里在参数为空时回落到落盘配置，语义变成「确保代理在跑，且配置和上次 JS
        // 给的一致」。JS 显式改配置仍直调 EchProxyCore.ensureStarted，所以用户在
        // 设置页清空 DoH 的意图不受影响。
        val (savedDoh, savedIps) = EchProxyCore.appContext
            ?.let { EchProxyCore.loadSavedConfig(it) }
            ?: ("" to "")
        val useDoh = doh.ifBlank { EchProxyCore.effectiveDoh(savedDoh) }
        val useIps = ipList.ifBlank { savedIps }
        val p = EchProxyCore.ensureStarted(0, useDoh, useIps)
        if (p > 0) {
            port = p
            Log.i(TAG, "Go ECH proxy running on 127.0.0.1:$p")
            return true
        }
        Log.w(TAG, "Go ECH proxy failed to start")
        return false
    }

    fun stop() {
        EchProxyCore.stop()
        port = DEFAULT_PORT
    }

    /** https://archiveofourown.org 页面地址 → http://127.0.0.1:<port>（路径原样保留）（EchWebView 页面加载入口）。 */
    fun rewriteWebUrl(url: String): String {
        if (url.startsWith("https://$HOST")) return baseUrl + url.substringAfter(HOST)
        if (url.startsWith("https://www.$HOST")) return baseUrl + url.substringAfter(HOST)
        return url
    }
}
