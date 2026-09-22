package com.co3.ech

import com.facebook.react.modules.network.ReactCookieJarContainer
import okhttp3.OkHttpClient
import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * 带 ECH 的共享 OkHttp 客户端。
 * OkHttp 层（RN 的请求）与 WebView 拦截层共用同一个实例：连接池、Cookie、ECH 配置都共享。
 *
 * 全部使用标准语义：
 *   - cookieJar 直接挂 CookieManager（与 WebView 双向共享）
 *   - 重定向、gzip、HTTP2 由 OkHttp 自己处理（不再有"库吃掉 302 Set-Cookie"这类问题）
 *   - TLS 走 ConscryptEch.socketFactory，保护域名自动注入 ECHConfigList
 *
 * ⚠️ **受保护域强制不走代理** —— 这是 2026-09-22 定位到的最后一块拼图。
 *
 * 起因：同一个网关，浏览器能开、bangumi-ech（自家 App）飞快，CO3 却卡十几秒。
 * 逐行对比 bangumi 的 `BgmEchTransport` 后发现它对受保护域显式返回 `Proxy.NO_PROXY`，
 * 而 CO3 的主客户端没有 —— 于是继承了 `ProxySelector.getDefault()`，即**系统代理**。
 *
 * 手机上有代理/VPN 类 App（或 APN 配了代理）时请求会被塞进那个代理，
 * **而代理不通的表现是「卡死」而不是快速报错** —— 所以之前五个假设全被推翻：
 * 网关 IP、域名解析、POST/GET、bootstrap 递归、公网放行，全都不是原因。
 *
 * 更早只修了 DoH 客户端（EchDoh.bootstrapClient），所以日志里 `net.doh.ok` 与
 * `tls.ech.inject` 都正常，但真正发请求的这条路仍报
 * `ech.refetch.begin err=SocketTimeoutException: timeout`。
 *
 * 顺带也是正确的隐私取向：保护域本就不该经过第三方代理。
 */
object EchHttp {

    val client: OkHttpClient by lazy {
        // 首次真正需要网络时再初始化 Conscrypt（那时 SoLoader/Fresco 都已就绪）
        ConscryptEch.install()
        OkHttpClient.Builder()
            // proxy(null)：清掉可能存在的固定代理，统一交给下面的 proxySelector 决定
            .proxy(null)
            .proxySelector(object : ProxySelector() {
                private val original: ProxySelector? = ProxySelector.getDefault()

                override fun select(uri: URI): List<Proxy> {
                    // 保护域一律直连：走代理既可能卡死，也失去 ECH 的意义
                    if (EchHosts.isProtected(uri.host.orEmpty())) return listOf(Proxy.NO_PROXY)
                    // 其余域名保持用户原有设置，不改变用户意图
                    return original?.select(uri) ?: listOf(Proxy.NO_PROXY)
                }

                override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) {
                    original?.connectFailed(uri, sa, ioe)
                }
            })
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
