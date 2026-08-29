package com.co3.ech

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.liar.han1meplus.EchHttpClient
import android.util.Base64
import org.json.JSONObject

@ReactModule(name = "EchNative")
class EchNativeModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "EchNative"
    @ReactMethod
    fun init(promise: Promise) {
        try {
            EchHttpClient.init(reactContext.applicationContext)
            promise.resolve(EchHttpClient.isLoaded)
        } catch (e: Exception) { promise.reject("init_failed", e.message) }
    }
    @ReactMethod
    fun isLoaded(promise: Promise) { promise.resolve(EchHttpClient.isLoaded) }
    @ReactMethod
    fun request(url: String, method: String, headers: ReadableArray?, body: String?, dohUrl: String, dohResolve: String, promise: Promise) {
        try {
            val h = mutableListOf<String>()
            if (headers != null) for (i in 0 until headers.size()) h.add(headers.getString(i)!!)
            val bodyBytes = body?.let { Base64.decode(it, Base64.DEFAULT) }
            val jsonStr = EchHttpClient.request(method, url, h.toTypedArray(), bodyBytes, dohUrl, dohResolve)
            promise.resolve(jsonStr)
        } catch (e: Exception) { promise.reject("request_failed", e.message, e) }
    }
}
