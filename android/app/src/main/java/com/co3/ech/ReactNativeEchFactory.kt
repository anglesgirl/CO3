package com.co3.ech

import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.ReactCookieJarContainer
import okhttp3.OkHttpClient

class ReactNativeEchFactory : OkHttpClientFactory {
    override fun createNewNetworkModuleClient(): OkHttpClient {
        return OkHttpClient.Builder()
            .cookieJar(ReactCookieJarContainer())
            // 【必须是 network interceptor，不能是 application interceptor】
            // 原因（2026-09-11）：native 库已关闭 FOLLOWLOCATION，重定向交回 OkHttp 处理。
            // OkHttp 的跟随发生在 RetryAndFollowUpInterceptor（application 拦截器**内侧**），
            // 若把本拦截器挂在 application 层，第二跳（GET 到重定向目标）就不会经过它 →
            // 那一跳会以明文直连目标站，直接泄漏 SNI，破掉 fail-closed。
            // 挂在 network 层后，每一跳都会经过它，全部走 ECH。
            // 另外 BridgeInterceptor 在 network 层之前已按 CookieJar 注入 Cookie，
            // 拦截器里的手动注入逻辑（request.header("Cookie") == null 时才注入）不会重复。
            .addNetworkInterceptor(CoEchInterceptor())
            .build()
    }
}
