package com.co3.ech

import dev.kathttp3.DohResolver
import dev.kathttp3.KatHttp3Client
import dev.kathttp3.KatHttp3ClientConfig
import dev.kathttp3.KatHttp3Header
import dev.kathttp3.KatHttp3Request
import dev.kathttp3.TrustMode
import kotlinx.coroutines.runBlocking

/**
 * H3（QUIC/UDP）+ ECH 引擎路径 —— 「网络通」的正解。
 *
 * 背景（真机日志 + 用户实测）：H1.1/H2 走 TCP，带 ECH 的 ClientHello 在
 * 移动网络被概率性干扰（用户实测 h2 打不开、浏览器 h3 一直正常），冷启动
 * 第一击连续 4 候选全撞上干扰窗口就 30s 全灭。H3 走 UDP/QUIC，特征不同、
 * 被放行 —— 浏览器一切正常的通路就是 H3。kathttp3-ech 是原生 H3 客户端
 * （ngtcp2 + nghttp3 + BoringSSL）。
 *
 * 解析器直接用 kathttp3 自带的 [DohResolver]：RFC 8484 JSON、默认端点
 * cloudflare-dns.com（与浏览器验证正常的公共 DoH 同源）、一次查询
 * A/AAAA/HTTPS 同时拿地址与 ECHConfigList、5s 超时、自带 TTL 缓存。
 * CO3 自研的多端点探测链（EchDohConfig/EchDohResolver）在冷启动首击
 * 上被日志实证拖到 6~8s，已弃用。
 */
object EchHttp3Client {

    private val client: KatHttp3Client by lazy {
        KatHttp3Client(
            KatHttp3ClientConfig(
                // CO3 JS 侧（echKy）统一跟 302，引擎不跟随 —— 与 H1.1 引擎
                // CURLOPT_FOLLOWLOCATION=0 同构。
                followRedirects = false,
                // 15s：真机日志实证 H3 首击冷路径 6.3s（engine_ok_h3
                // totalMs=6294），8s 超时线太紧会误杀首击；热路径 683ms
                // 不受影响。
                requestTimeoutMillis = 15_000,
                // kathttp3 自带 DoH 解析器（A/AAAA/HTTPS + ECH），与浏览器
                // 同源的 cloudflare-dns.com 公共 DoH。
                resolver = DohResolver(),
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
        val resp = runBlocking {
            client.execute(
                KatHttp3Request(
                    method = method,
                    url = url,
                    headers = hdrs,
                    body = body,
                ),
            )
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
