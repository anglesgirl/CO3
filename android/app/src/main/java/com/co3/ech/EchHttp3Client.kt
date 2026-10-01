package com.co3.ech

import dev.kathttp3.DnsResolver
import dev.kathttp3.DohResolver
import dev.kathttp3.KatHttp3Client
import dev.kathttp3.KatHttp3ClientConfig
import dev.kathttp3.KatHttp3Header
import dev.kathttp3.KatHttp3Request
import dev.kathttp3.ResolvedAddress
import dev.kathttp3.TrustMode
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentHashMap

/**
 * H3（QUIC/UDP）+ ECH 引擎路径 —— 「网络通」的正解。
 *
 * 背景（真机日志 + 用户实测）：H1.1/H2 走 TCP，带 ECH 的 ClientHello 在
 * 移动网络被概率性干扰（用户实测 h2 打不开、浏览器 h3 一直正常），冷启动
 * 第一击连续 4 候选全撞上干扰窗口就 30s 全灭。H3 走 UDP/QUIC，特征不同、
 * 被放行 —— 浏览器一切正常的通路就是 H3。kathttp3-ech 是原生 H3 客户端
 * （ngtcp2 + nghttp3 + BoringSSL）。
 *
 * 解析器用 kathttp3 自带的 [DohResolver]，但端点必须是 CO3 配置的
 * Cloudflare Gateway DoH（[EchDohConfig]：pieqllv9i7 主 + 2 fallback，
 * 与 JS 侧 initEch 默认一致），**不能用 [DohResolver] 的默认端点**：
 * 默认是公共 cloudflare-dns.com，在用户网络下不可用 —— 切到默认端点后
 * 冷启动零网络直到超时（浏览器用网关 DoH 完全正常；Go 时代走网关端点
 * 偶然可用；旧 Co3DnsResolver 走网关端点时 engine_ok_h3 多次成功）。
 * 网关端点是用户自有 Zero Trust 端点，不在任何封锁名单上。
 */
object EchHttp3Client {

    /**
     * CO3 网关 DoH 驱动的解析器：按 [EchDohConfig] 的端点顺序逐个尝试，
     * 每个端点复用同一个 [DohResolver] 实例（保住它的 TTL 缓存）。
     * 单端点 connect/read 各 3s，避免一个坏端点拖住整个冷启动。
     */
    private class Co3GatewayDohResolver : DnsResolver {
        private val resolvers = ConcurrentHashMap<String, DohResolver>()

        override fun resolve(host: String, port: Int): List<ResolvedAddress> {
            val endpoints = EchDohConfig.load().dohEndpoints
            for (ep in endpoints) {
                val r = resolvers.getOrPut(ep) {
                    DohResolver(endpoint = ep, connectTimeoutMs = 3_000, readTimeoutMs = 3_000)
                }
                val addrs = runCatching { r.resolve(host, port) }.getOrNull()
                if (!addrs.isNullOrEmpty()) return addrs
            }
            return emptyList()
        }
    }

    private val client: KatHttp3Client by lazy {
        KatHttp3Client(
            KatHttp3ClientConfig(
                // CO3 JS 侧（echKy）统一跟 302，引擎不跟随 —— 与 H1.1 引擎
                // CURLOPT_FOLLOWLOCATION=0 同构。
                followRedirects = false,
                // 15s：真机日志实证 H3 首击冷路径 6.3s（engine_ok_h3
                // totalMs=6294），8s 超时线太紧会误杀首击；热路径 683ms
                // 不受影响。注意：这是引擎内部兜底超时，调用方
                // （EchEngineClient）通过 request() 的 timeoutMs 给更紧
                // 的预算（8s），超时即回退 H1.1。
                requestTimeoutMillis = 15_000,
                // kathttp3 自带 DoH 解析器（A/AAAA/HTTPS + ECH），端点取
                // CO3 网关配置 —— 见本文件 KDoc，勿换回默认端点。
                resolver = Co3GatewayDohResolver(),
                trustMode = TrustMode.PLATFORM,
            ),
            // 无 ApplicationContext：不依赖平台网络监控
            null,
        )
    }

    /**
     * 冷启动预热。真机日志实证：H3 首击冷路径 6~8s（native 初始化 +
     * 解析 + ECH 配置获取 + 建 QUIC 会话），会踩业务超时线；预热后热路径
     * <1s（实测 683ms）。启动阶段后台调一次，把冷路径提前完成，用户点击
     * 时秒开。
     */
    fun warmup() {
        val c = client // 触发 lazy：native 加载 + worker 启动
        // 一次轻量 H3 请求真实建立 QUIC 会话并触发解析缓存；失败不致命，
        // 用户点击时按需重试。超时与业务一致（15s）。
        runCatching {
            request("https://archiveofourown.org/favicon.ico", "GET", "", null, 15_000)
        }
    }

    /** 与 [EchHttpNative.request] 同签名；headers 为 \r\n 拼接的原始头。 */
    fun request(
        url: String,
        method: String,
        headers: String,
        body: ByteArray?,
        timeoutMs: Long,
    ): EchHttpNative.Response {
        val hdrs = headers.split("\r\n").filter { it.isNotBlank() }.mapNotNull { line ->
            val i = line.indexOf(':')
            if (i <= 0) null else KatHttp3Header(line.substring(0, i).trim(), line.substring(i + 1).trim())
        }
        // timeoutMs 是调用方给的预算（EchEngineClient 给 H3 只留 8s，
        // 超时立即回退 H1.1）；引擎内部 15s 是最后兜底。
        val resp = runBlocking {
            withTimeout(timeoutMs) {
                client.execute(
                    KatHttp3Request(
                        method = method,
                        url = url,
                        headers = hdrs,
                        body = body,
                    ),
                )
            }
        }
        val headerText = resp.headers.joinToString("\r\n") { "${it.name}: ${it.value}" }
        return EchHttpNative.Response(
            status = resp.status,
            headers = headerText,
            body = resp.body,
            echAccepted = true,
            echRetries = 0, // kathttp3 无应用层重试计数（网络层内部处理）
        )
    }
}
