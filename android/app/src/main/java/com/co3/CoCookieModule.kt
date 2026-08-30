package com.co3

import android.webkit.CookieManager
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule

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
            val has = c.contains("_otwarchive_session")
            promise.resolve(has)
        } catch (e: Exception) { promise.resolve(false) }
    }
}
