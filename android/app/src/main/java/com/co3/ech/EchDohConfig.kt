package com.co3.ech

import android.content.Context
import android.util.Log

/**
 * 引擎侧需要的 DoH 配置（端点列表 / 借用的 ECH 配置域名 / 优选 IP）。
 *
 * 为什么需要落盘：ech_http 引擎自己不查 DoH —— 它只接受 echConfig + connectIp
 * 两个参数，都由调用方准备好。而 DoH 端点由 JS 侧持有（AsyncStorage），Kotlin
 * 读不到。所以 JS 在 initEch 时通过 EchHttpModule.setDohConfig() 存进来，
 * WebView 拦截路径再读回去用。
 *
 * 这与 Go 代理时代的分工是一样的（配置权威在 JS），只是引擎不监听端口、
 * 也没法「把配置顺手交给本地服务」，所以必须显式落一份。
 */
object EchDohConfig {
    private const val TAG = "CO3-ECHHTTP"
    private const val PREFS = "co3_ech_http"
    private const val KEY_DOH = "doh_endpoints"
    private const val KEY_CONFIG_HOST = "config_host"
    private const val KEY_IPS = "address_overrides"

    /** 由 EchHttpModule 构造时注入，供 intercept 路径读取（用 applicationContext，不泄漏 Activity）。 */
    @Volatile
    var appContext: Context? = null

    data class Snapshot(
        val dohEndpoints: List<String>,
        val configHost: String?,
        val addressOverrides: List<String>,
    ) {
        val isEmpty: Boolean get() = dohEndpoints.isEmpty()
    }

    fun save(context: Context, doh: String, configHost: String, ips: String) {
        runCatching {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_DOH, doh)
                .putString(KEY_CONFIG_HOST, configHost)
                .putString(KEY_IPS, ips)
                .apply()
        }.onFailure { Log.w(TAG, "保存 DoH 配置失败: ${it.message}") }
    }

    /** 读当前配置；appContext 未就绪时返回空快照（调用方按 fail-closed 处理）。 */
    fun load(): Snapshot {
        val ctx = appContext ?: return Snapshot(emptyList(), null, emptyList())
        return runCatching {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            Snapshot(
                dohEndpoints = splitList(sp.getString(KEY_DOH, "")),
                configHost = (sp.getString(KEY_CONFIG_HOST, "") ?: "").trim().ifEmpty { null },
                addressOverrides = splitList(sp.getString(KEY_IPS, "")),
            )
        }.getOrElse {
            Log.w(TAG, "读取 DoH 配置失败: ${it.message}")
            Snapshot(emptyList(), null, emptyList())
        }
    }

    private fun splitList(raw: String?): List<String> =
        (raw ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
}
