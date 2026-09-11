package com.co3.ech

import com.facebook.react.modules.network.ReactCookieJarContainer
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * 带 ECH 的共享 OkHttp 客户端。
 * OkHttp 层（RN 的请求）与 WebView 拦截层共用同一个实例：连接池、Cookie、ECH 配置都共享。
 *
 * 全部使用标准语义：
 *   - cookieJar 直接挂 CookieManager（与 WebView 双向共享）
 *   - 重定向、gzip、HTTP2 由 OkHttp 自己处理（不再有"库吃掉 302 Set-Cookie"这类问题）
 *   - TLS 走 ConscryptEch.socketFactory，保护域名自动注入 ECHConfigList
 */
object EchHttp {

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .sslSocketFactory(ConscryptEch.socketFactory, ConscryptEch.trustManager)
            .dns(EchDns())
            .cookieJar(ReactCookieJarContainer())
            // 只负责 ECH 被拒时清缓存以便用 retryConfigs 重试，不做任何传输改写
            .addInterceptor(EchRetryInterceptor())
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
