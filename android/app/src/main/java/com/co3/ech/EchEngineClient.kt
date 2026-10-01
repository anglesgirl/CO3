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
        val tStart = System.currentTimeMillis()
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
        // 候选顺序 v4 在前（DoH 返回顺序），v6 只作兜底；IPv6 在国内移动网络
        // 实测可通（用户确认），保留全部候选不丢兜底机会。
        val candidates = if (cfg.addressOverrides.isNotEmpty()) {
            cfg.addressOverrides
        } else {
            route.addresses
        }
        if (candidates.isEmpty()) throw IOException("DoH 未返回任何地址")

        // perTry 固定 3s：H1.1 ECH 冷握手在移动网络经常瞬时失败（真机日志
        // totalMs=30033 = 4 候选 × 7.5s 全灭），单地址 7.5s 太慢。3s×4=12s
        // 一轮出结果，失败立即整轮重试（2 轮 ≤ 24s，不超调用方 30s 预算）。
        val perTry = 3_000L
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
                        // 诊断：成功路径带实际连接 IP / echAccepted / 状态码 / 耗时，
                        // 服务器统计才能区分"哪个 IP 行、哪个 IP 不行"。
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

        // 诊断：失败路径上报全部候选 IP、逐地址失败明细与最终错误 ——
        // 定位"是 IP 不可达还是 ECH 被拒、哪些地址失败"。
        com.co3.Diagnostics.event(
            "engine_fail",
            mapOf(
                "host" to host,
                "url" to url.take(100),
                "candidates" to candidates.joinToString("|").take(200),
                "attempts" to attemptLog.joinToString("|").take(300),
                "err" to (lastError?.message ?: "所有候选地址都失败"),
                "totalMs" to (System.currentTimeMillis() - tStart).toString(),
            ),
        )

        throw lastError
            ?: IOException("所有候选地址都失败（共 ${candidates.size} 个，fail-closed 未降级明文）")
    }
}
