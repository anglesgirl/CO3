package com.co3.ech

import android.util.Log

/**
 * ech_http 原生引擎（去 Dart 化后的 C++ 桥）在 CO3 侧的门面。
 *
 * 与现有本地 Go 代理的根本差别：**引擎不监听端口**，它是命令式调用的 HTTP
 * 客户端。所以调用点从「把 URL 改写成 http://127.0.0.1:<port> 再交给代理」
 * 变成「直接调这里的 request()」——TLS/ECH 在同一进程内完成，不再需要端口，
 * 也不再有「代理没起来就整条链路不可用」的启动时序问题。
 *
 * 线程约定：request() 是**阻塞**调用（引擎在内部工作线程推进，这里等结果）。
 * 只能在后台线程调用，严禁放在主线程。
 *
 * 失败语义：**fail-closed**。ECH 配置无效/不受支持时引擎直接拒绝并返回
 * status=0，绝不降级明文 SNI —— 在 GFW 下明文必定被 RST，降级没有可用性收益，
 * 只会多一次 SNI 暴露。
 */
object EchHttpNative {
    private const val TAG = "CO3-ECHHTTP"

    /** 一次请求的完整结果。status == 0 表示引擎侧失败（如 ECH 配置被拒）。 */
    class Response(
        @JvmField val status: Int,
        @JvmField val headers: String,
        @JvmField val body: ByteArray,
        @JvmField val echAccepted: Boolean,
        @JvmField val echRetries: Int,
    ) {
        fun firstHeaderLine(): String =
            headers.lineSequence().firstOrNull()?.trim().orEmpty()
    }

    private val loaded: Boolean = try {
        System.loadLibrary("co3ech")
        true
    } catch (t: Throwable) {
        Log.e(TAG, "libco3ech.so 加载失败（CI 未把引擎打进 jniLibs？）", t)
        false
    }

    /** 引擎是否可用。false 时调用方必须保留旧路径，不能直接失败。 */
    val isAvailable: Boolean get() = loaded

    /** 引擎版本串，形如 libcurl/8.22.0 BoringSSL zlib/1.3.2 */
    val version: String
        get() = if (loaded) {
            runCatching { nativeVersion() }.getOrDefault("unknown")
        } else {
            "unavailable"
        }

    private external fun nativeVersion(): String

    private external fun nativeRequest(
        url: String,
        method: String,
        headers: String,
        echConfig: String?,
        connectIp: String?,
        timeoutMs: Long,
        maxResponseBytes: Long,
    ): Response?

    /**
     * 发起一次请求（阻塞，勿在主线程调用）。
     *
     * @param echConfig DoH 查到的 ech= 值（base64，不含引号）。传 null 表示不启用
     *   ECH —— 仅用于对照排障，AO3 正式请求必须带上。
     * @param connectIp 直连 IP（优选节点）。SNI/Host 仍按 url 的域名走。
     */
    fun request(
        url: String,
        method: String = "GET",
        headers: String = "",
        echConfig: String? = null,
        connectIp: String? = null,
        timeoutMs: Long = 30_000L,
        maxResponseBytes: Long = 32L * 1024 * 1024,
    ): Response? {
        if (!loaded) {
            Log.w(TAG, "引擎不可用，拒绝 $method $url")
            return null
        }
        return try {
            nativeRequest(
                url, method, headers, echConfig, connectIp, timeoutMs, maxResponseBytes,
            )
        } catch (t: Throwable) {
            Log.e(TAG, "nativeRequest 异常: $method $url", t)
            null
        }
    }
}
