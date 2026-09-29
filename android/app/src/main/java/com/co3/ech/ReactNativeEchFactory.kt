package com.co3.ech

import com.facebook.react.modules.network.CookieJarContainer
import com.facebook.react.modules.network.OkHttpClientFactory
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient

/**
 * RN 网络栈（fetch / 图片等所有走 RN OkHttp 的请求）：
 * AO3 域请求重写走本地 Go ECH 代理（http://127.0.0.1:<port>）。
 *
 * 【为什么这样】安卓回迁 Go 后，TLS/ECH 全部由 Go 代理负责（同进程内嵌）。
 * RN 侧不能再直连 https://archiveofourown.org（系统 OkHttp 无 ECH，SNI 会
 * 明文暴露并被 RST）。这里用拦截器把 AO3 请求重写到本地代理地址：
 *   - URL: https://archiveofourown.org 页面地址 → http://127.0.0.1:<port>（路径原样保留）
 *   - 传输/ECH/重定向/Cookie 由 Go 代理统一处理（jar 是权威，页面加载后
 *     EchProxyCore.syncCookiesToCookieManager() 同步进 CookieManager）
 *   - 非 AO3 请求原样放行
 * 拦截器只动 URL；Referer/Origin 保持原值（Go 侧只重写 127 来源，符合预期）。
 *
 * 【必须挂 CookieJarContainer】RN 的 Fresco 图片模块初始化时会强转
 * `client.cookieJar() as CookieJarContainer`（FrescoModule.kt:162）——默认
 * NoCookies 不是该接口，启动即崩 ClassCastException。这里挂一个空实现的
 * CookieJarContainer：cookie 权威在 Go jar（不走 CookieManager），所以
 * save/load 都是空操作，只满足类型契约。
 */
class ReactNativeEchFactory : OkHttpClientFactory {
    override fun createNewNetworkModuleClient(): OkHttpClient =
        OkHttpClient.Builder()
            .cookieJar(
                object : CookieJarContainer {
                    override fun setCookieJar(cookieJar: CookieJar) {}
                    override fun removeCookieJar() {}
                    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {}
                    override fun loadForRequest(url: HttpUrl): List<Cookie> = emptyList()
                },
            )
            .addInterceptor { chain ->
                val req = chain.request()
                val url = req.url.toString()
                val port = EchProxyCore.port
                if (port != 0 &&
                    (url.startsWith("https://archiveofourown.org") ||
                        url.startsWith("https://www.archiveofourown.org"))
                ) {
                    val base = "http://127.0.0.1:$port"
                    val rewritten = url
                        .replaceFirst("https://www.archiveofourown.org", base)
                        .replaceFirst("https://archiveofourown.org", base)
                    return@addInterceptor chain.proceed(req.newBuilder().url(rewritten).build())
                }
                chain.proceed(req)
            }
            .build()
}
