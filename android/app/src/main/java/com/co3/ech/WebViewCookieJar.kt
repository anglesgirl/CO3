package com.co3.ech

import android.webkit.CookieManager
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * 与 WebView 双向共享的 CookieJar：读写都走 android.webkit.CookieManager。
 *
 * 背景（2026-10-02 真机）：EchHttp.client 之前挂的是裸 ReactCookieJarContainer()，
 * 内部 jar 为 null 时 save/load 都是空操作 —— 引擎的 Set-Cookie 全丢，
 * CookieManager 始终为空，导致 hasUserCredentials() 永 false，
 * 「刷新登录状态」服务端明明认出已登录，refresh() 一读本地又判成未登录。
 */
class WebViewCookieJar : CookieJar {
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        try {
            val cm = CookieManager.getInstance()
            for (c in cookies) {
                // CookieManager.setCookie 需要完整 Set-Cookie 语义；Cookie.toString()
                // 输出 name=value，domain/path 从 url 推导，满足 AO3 的会话需求。
                // HttpOnly 的 cookie CookieManager 也能存（只是 JS 读不到）。
                cm.setCookie(url.toString(), c.toString())
            }
            cm.flush()
        } catch (_: Exception) {}
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        return try {
            val cm = CookieManager.getInstance()
            val header = cm.getCookie(url.toString()) ?: return emptyList()
            // "a=1; b=2" → List<Cookie>
            header.split(";").mapNotNull { part ->
                val kv = part.trim()
                val idx = kv.indexOf('=')
                if (idx <= 0) return@mapNotNull null
                Cookie.Builder()
                    .name(kv.substring(0, idx).trim())
                    .value(kv.substring(idx + 1).trim())
                    .domain(url.host)
                    .path("/")
                    .build()
            }
        } catch (_: Exception) {
            emptyList()
        }
    }
}
