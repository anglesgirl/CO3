package com.co3

import android.webkit.CookieManager
import com.facebook.react.bridge.*
import android.util.Log
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = "CoCookieModule")
class CoCookieModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "CoCookieModule"

    @ReactMethod
    fun getCookie(url: String, promise: Promise) {
        // 日志：JS 在查 cookie
        try {
            val cm = CookieManager.getInstance()
            val cookie = cm.getCookie(url) ?: ""
            try { Diagnostics.event("cookie_get", mapOf("url" to url, "has" to (cookie.contains("_otwarchive_session").toString()), "len" to cookie.length.toString(), "preview" to cookie.take(120))) } catch(_:Exception){}
            try { android.util.Log.i("CO-COOKIE", "getCookie $url hasSession=${cookie.contains("_otwarchive_session")} len=${cookie.length}") } catch(_:Exception){}
            promise.resolve(cookie)
        } catch (e: Exception) { promise.reject("ERR", e.message) }
    }

    @ReactMethod
    fun syncSessionToJs(url: String, promise: Promise) {
        try {
            val c = CookieManager.getInstance().getCookie(url) ?: ""
            val m = Regex("_otwarchive_session=([^;]+)").find(c)
            val token = m?.groupValues?.get(1) ?: ""
            if (token.isNotEmpty()) {
                try { com.co3.Diagnostics.event("sync_session", mapOf("len" to token.length.toString())) } catch(_:Exception){}
                Log.i("CO-COOKIE", "syncSession token len="+token.length)
            }
            promise.resolve(token)
        } catch (e: Exception) { promise.reject("ERR", e.message) }
    }

    @ReactMethod
    fun clearSession(promise: Promise) {
        try {
            val cm = CookieManager.getInstance()
            // 旧 Go 教训：path="" 的 host-only cookie 用 MaxAge=-1 删不掉，必须 removeAll 或精确 domain/path 全删
            // 这里直接 removeAllCookies + 额外对 4 个 host 写过期标记兜底
            cm.removeAllCookies { }
            val expire = "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
            val hosts = listOf("archiveofourown.org", ".archiveofourown.org", "www.archiveofourown.org", ".www.archiveofourown.org")
            for (h in hosts) {
                for (name in listOf("_otwarchive_session","user_credentials","cf_clearance","__cf_bm")) {
                    try { cm.setCookie("https://"+h, name+"=; Domain="+h+"; Path=/; "+expire) } catch(_:Exception){}
                    try { cm.setCookie("https://"+h, name+"=; Path=/; "+expire) } catch(_:Exception){}
                }
            }
            cm.flush()
            try { com.co3.Diagnostics.event("cookie_clear", mapOf("ok" to "1")) } catch(_:Exception){}
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("ERR", e.message) }
    }

    @ReactMethod
    fun hasSession(url: String, promise: Promise) {
        try {
            val c = CookieManager.getInstance().getCookie(url) ?: ""
            val has = c.contains("_otwarchive_session")
            try { Diagnostics.event("cookie_has", mapOf("url" to url, "has" to has.toString())) } catch(_:Exception){}
            promise.resolve(has)
        } catch (e: Exception) { promise.resolve(false) }
    }

    /**
     * 登录验证：CookieManager 里有没有 user_credentials（AO3 登录成功才会下发该 cookie）。
     * 比网络请求校验 HTML 可靠得多——WebView 登录成功后真实 cookie 就在这。
     */
    @ReactMethod
    fun hasUserCredentials(promise: Promise) {
        try {
            val cm = CookieManager.getInstance()
            var found = false
            var frag = ""
            for (u in listOf("https://archiveofourown.org/", "https://www.archiveofourown.org/")) {
                val c = cm.getCookie(u) ?: ""
                if (c.contains("user_credentials")) {
                    found = true
                    frag = c.take(120)
                    break
                }
            }
            try { Diagnostics.event("cookie_user_creds", mapOf("found" to found.toString(), "preview" to frag)) } catch(_:Exception){}
            promise.resolve(found)
        } catch (e: Exception) { promise.resolve(false) }
    }

    // 远程诊断日志开关（关于页连点 7 次版本号切换）
    @ReactMethod
    fun setDiagnosticsEnabled(enabled: Boolean) {
        try { Diagnostics.setEnabled(enabled) } catch (_: Exception) {}
    }

    @ReactMethod
    fun isDiagnosticsEnabled(promise: Promise) {
        try { promise.resolve(Diagnostics.isEnabled()) } catch (e: Exception) { promise.resolve(false) }
    }
}
