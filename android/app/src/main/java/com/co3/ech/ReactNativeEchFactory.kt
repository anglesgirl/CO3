package com.co3.ech

import com.facebook.react.modules.network.OkHttpClientFactory
import okhttp3.OkHttpClient

/**
 * RN 的网络栈直接复用共享的 ECH 客户端（EchHttp.client）：
 *   - TLS 走 Conscrypt（保护域名自动注入 ECHConfigList）
 *   - Dns 走 DoH（避开大陆 DNS 污染）
 *   - cookieJar 挂 CookieManager（与 WebView 双向共享）
 *   - 重定向/Cookie/gzip 全部由 OkHttp 标准语义处理
 *
 * 不再需要任何"把请求转到 JNI 再手工拼响应"的拦截器 —— 那套做法会吃掉
 * 302 响应里的 Set-Cookie（例如 AO3 登录成功返回的 user_credentials），
 * 也正是登录长期失败的根因。
 */
class ReactNativeEchFactory : OkHttpClientFactory {
    override fun createNewNetworkModuleClient(): OkHttpClient = EchHttp.client
}
