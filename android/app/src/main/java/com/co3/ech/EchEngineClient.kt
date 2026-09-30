package com.co3.ech

import android.util.Log
import java.io.IOException

/**
 * 引擎请求的统一入口：DoH 选路 + 逐个尝试候选地址。
 *
 * 为什么要逐个试：国内到 Cloudflare 不同 IP 段的可达性差异极大（有的秒连、
 * 有的直接超时），而 DoH 的 ipv4hint / A 记录一次会给好几个地址。以前只取
 * `addresses.first()`，撞上不可达的那个就整条链路失败 —— 真机上表现为
 * 「引擎请求失败 15006ms」+ 首页自检超时（2026-09-30 诊断实证）。
 * 历史上 Go 版本靠「优选 IP 扫描」回避这个问题，那层已按用户要求移除，
 * 所以现在必须自己在候选里挑能用的。
 *
 * 用户显式配置的优选 IP 优先级最高：非空时只用它，不再自动试其它地址
 * （用户既然手填，就按他说的走）。
 */
object EchEngineClient {

    private const val TAG = "CO3-ECHHTTP"

    /**
     * 发一次请求，成功（引擎拿到响应且 status != 0）即返回。
     *
     * @param totalTimeoutMs 所有候选地址共享的总预算，内部按候选数均分，
     *   避免 N 个地址各等 30 秒把用户体验拖到一分钟以上。
     */
    fun request(
        host: String,
        url: String,
        method: String,
        headers: String,
        body: ByteArray? = null,
        totalTimeoutMs: Long = 30_000L,
    ): EchHttpNative.Response {
        if (!EchHttpNative.isAvailable) {
            throw IOException("引擎不可用（libco3ech.so 未加载）—— fail-closed 不放行明文")
        }

        val cfg = EchDohConfig.load()
        if (cfg.isEmpty) throw IOException("尚无 DoH 配置（JS initEch 未落盘）")

        val route = EchDohResolver.resolve(
            host = host,
            dohEndpoints = cfg.dohEndpoints,
            addressOverrides = cfg.addressOverrides,
            configHost = cfg.configHost,
        )

        // 用户手配的地址优先且独占；否则用 DoH 给出的全部候选。
        val candidates = if (cfg.addressOverrides.isNotEmpty()) {
            cfg.addressOverrides
        } else {
            route.addresses
        }
        if (candidates.isEmpty()) throw IOException("DoH 未返回任何地址")

        val perTry = (totalTimeoutMs / candidates.size).coerceAtLeast(3_000L)
        var lastError: Exception? = null

        for ((idx, ip) in candidates.withIndex()) {
            val t0 = System.currentTimeMillis()
            try {
                val resp = EchHttpNative.request(
                    url = url,
                    method = method,
                    headers = headers,
                    body = body,
                    echConfig = route.echConfig,
                    connectIp = ip,
                    timeoutMs = perTry,
                )
                if (resp != null && resp.status != 0) {
                    if (idx > 0) {
                        Log.i(TAG, "第 ${idx + 1} 个候选地址可用: $ip（前 ${idx} 个失败）")
                    }
                    return resp
                }
                lastError = IOException("地址 $ip 未取得响应（ECH 握手失败或被拒绝）")
            } catch (e: Exception) {
                lastError = e
            }
            Log.w(
                TAG,
                "候选地址 $ip 失败（${System.currentTimeMillis() - t0}ms），尝试下一个",
            )
        }

        throw lastError
            ?: IOException("所有候选地址都失败（共 ${candidates.size} 个，fail-closed 未降级明文）")
    }
}
