package com.co3.ech

import com.facebook.react.modules.network.CookieJarContainer
import com.facebook.react.modules.network.OkHttpClientFactory
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient

/**
 * RN 网络栈（fetch / 图片等所有走 RN OkHttp 的请求）：受保护域经 ech_http 引擎。
 *
 * 【为什么这样】RN 侧不能直连 https://archiveofourown.org（系统 OkHttp 无 ECH，
 * SNI 会明文暴露并被 RST）。实际转发全部交给 [EchEngineInterceptor]：DoH 取 ECH
 * 配置与地址 → CookieManager 读写 cookie → 引擎在同进程内完成 TLS + ECH。
 *
 * 【必须挂 CookieJarContainer】RN 的 Fresco 图片模块初始化时会强转
 * `client.cookieJar() as CookieJarContainer`（FrescoModule.kt:162）——默认
 * NoCookies 不是该接口，启动即崩 ClassCastException。cookie 权威现在在
 * CookieManager（引擎零 cookie 代码，由拦截器读写），所以这两个方法是空操作，
 * 只为满足类型契约。
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
            // 受保护域（AO3 等）全部经 ech_http 引擎：TLS + ECH 在同一进程内完成。
            // 不再改写 URL 到本地端口 —— 引擎不监听端口，改写反而会绕过 ECH。
            .addInterceptor { chain -> EchEngineInterceptor.intercept(chain) }
            .build()
}
