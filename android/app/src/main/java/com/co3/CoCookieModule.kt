package com.co3

import android.webkit.CookieManager
import com.facebook.react.bridge.*

@ReactModule(name = "CoCookieModule")
class CoCookieModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "CoCookieModule"

    @ReactMethod
    fun getCookie(url: String, promise: Promise) {
        try {
            val cm = CookieManager.getInstance()
            val cookie = cm.getCookie(url) ?: ""
            promise.resolve(cookie)
        } catch (e: Exception) { promise.reject("ERR", e.message) }
    }

    @ReactMethod
    fun hasSession(url: String, promise: Promise) {
        try {
            val c = CookieManager.getInstance().getCookie(url) ?: ""
            // _otwarchive_session 是 HttpOnly，webkit 可读，RN cookies 读不到，必须走这里
            val has = c.contains("_otwarchive_session")
            promise.resolve(has)
        } catch (e: Exception) { promise.resolve(false) }
    }

    @ReactMethod
    fun syncToKeychain(token: String, promise: Promise) {
        // 预留：若需把 WebView cookie 同步到 Keychain，可在此扩展
        promise.resolve(true)
    }
}
