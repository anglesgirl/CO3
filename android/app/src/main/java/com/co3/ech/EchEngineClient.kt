package com.co3.ech

import android.util.Log
import java.io.IOException

/**
 * 引擎请求的统一入口：H3 首选（QUIC/UDP 放行）→ 失败回退 H1.1 候选逐个试。
 *
 * 为什么 H3 首选（2026-10-01 真机日志 + 用户实测）：H1.1/H2 走 TCP，带 ECH
 * 的 ClientHello 在移动网络被概率性干扰（用户实测 h2 打不开、浏览器 h3 一直
 * 正常），冷启动第一击连续 4 候选全撞上干扰窗口就 30s 全灭；H3 走 UDP/QUIC
 * 被放行 —— 浏览器一切正常的通路就是 H3。kathttp3-ech 提供原生 H3+ECH，
 * 一次调用内部自行处理候选与地址族回退；失败立即回退本文件的 H1.1 引擎
 * （同样是 ECH，TCP 路径作为兜底）。
 */
object EchEngineClient {

    private const val TAG = "CO3-ECHHTTP"

    /**
     * 发一次请求，H3 成功即返回；否则 H1.1 候选逐个试。
     *
     * @param totalTimeoutMs 总预算（含 H3 + H1.1 回退），默认 30s。
     */
    fun request(
        host: String,
        url: String,
        method: String,
        headers: String,
        body: ByteArray? = null,
        totalTimeoutMs: Long = 30_000L,
    ): EchHttpNative.Response {
        val tStart = System.currentTimeMillis()
        if (!EchHttpNative.isAvailable) {
            throw IOException("引擎不可用（libco3ech.so 未加载）—— fail-closed 不放行明文")
        }

        val cfg = EchDohConfig.load()
        if (cfg.isEmpty) throw IOException("尚无 DoH 配置（JS initEch 未落盘）")

        // ============ 第一优先：H3（QUIC/UDP，被放行） ============
        // H3 内部用 kathttp3 自带 DohResolver + CO3 网关 DoH 端点解析
        // （地址 + ECH 配置，见 EchHttp3Client），自己处理候选回退；
        // 只给它 8s，失败立即回退 H1.1，不让两套吃满预算。
        var h3Error: String? = null
        if (totalTimeoutMs > 8_000L) {
            val h3t0 = System.currentTimeMillis()
            try {
                val h3 = EchHttp3Client.request(
                    url = url,
                    method = method,
                    headers = headers,
                    body = body,
                    timeoutMs = 8_000L,
                )
                if (h3 != null && h3.status != 0) {
                    com.co3.Diagnostics.event(
                        "engine_ok_h3",
                        mapOf(
                            "host" to host,
                            "url" to url.take(100),
                            "echAccepted" to "true",
                            "status" to h3.status.toString(),
                            "totalMs" to (System.currentTimeMillis() - tStart).toString(),
                            "h3Ms" to (System.currentTimeMillis() - h3t0).toString(),
                        ),
                    )
                    return h3
                }
                h3Error = "H3 无响应"
            } catch (e: Exception) {
                h3Error = e.message?.take(60) ?: "H3 异常"
            }
            Log.w(TAG, "H3 失败（${System.currentTimeMillis() - h3t0}ms, $h3Error），回退 H1.1")
        } else {
            h3Error = "预算不足 8s，直接 H1.1"
        }

        // ============ 兜底：H1.1（TCP + ECH），候选逐个试 ============
        val route = EchDohResolver.resolve(
            host = host,
            dohEndpoints = cfg.dohEndpoints,
            addressOverrides = cfg.addressOverrides,
            configHost = cfg.configHost,
        )
        val candidates = if (cfg.addressOverrides.isNotEmpty()) {
            cfg.addressOverrides
        } else {
            route.addresses
        }
        if (candidates.isEmpty()) throw IOException("DoH 未返回任何地址")

        // H3 已用掉 8s，H1.1 剩余预算内 perTry 2.5s×4×2 轮 ≈ 20s（总计 ≈28s）。
        val perTry = 2_500L
        var lastError: Exception? = null
        val attemptLog = mutableListOf<String>()
        for (round in 0 until 2) {
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
                        com.co3.Diagnostics.event(
                            "engine_ok",
                            mapOf(
                                "host" to host,
                                "url" to url.take(100),
                                "ip" to ip,
                                "echAccepted" to resp.echAccepted.toString(),
                                "status" to resp.status.toString(),
                                "attempt" to (idx + 1).toString(),
                                "round" to (round + 1).toString(),
                                "totalMs" to (System.currentTimeMillis() - tStart).toString(),
                                "dohEndpoints" to cfg.dohEndpoints.joinToString("|").take(200),
                            ),
                        )
                        return resp
                    }
                    attemptLog += "$ip:无响应"
                    lastError = IOException("地址 $ip 未取得响应（ECH 握手失败或被拒绝）")
                } catch (e: Exception) {
                    attemptLog += "$ip:${e.message?.take(40) ?: "异常"}"
                    lastError = e
                }
                Log.w(
                    TAG,
                    "候选地址 $ip 失败（${System.currentTimeMillis() - t0}ms），尝试下一个",
                )
            }
            Log.w(TAG, "第 ${round + 1} 轮候选全灭（${candidates.size} 个），立即整轮重试")
        }

        com.co3.Diagnostics.event(
            "engine_fail",
            mapOf(
                "host" to host,
                "url" to url.take(100),
                "candidates" to candidates.joinToString("|").take(200),
                "attempts" to attemptLog.joinToString("|").take(300),
                "h3" to (h3Error ?: ""),
                "err" to (lastError?.message ?: "所有候选地址都失败"),
                "totalMs" to (System.currentTimeMillis() - tStart).toString(),
            ),
        )

        throw lastError
            ?: IOException("所有候选地址都失败（共 ${candidates.size} 个，fail-closed 未降级明文）")
    }
}
