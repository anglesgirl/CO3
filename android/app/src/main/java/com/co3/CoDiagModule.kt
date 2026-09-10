package com.co3

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType

/**
 * 把 JS 侧的关键事件转发到统一诊断通道（[Diagnostics]）。
 *
 * 为什么需要：登录这类流程横跨 JS（取登录页、抽 CSRF token、提交表单）与原生
 * （ECH 拦截器发请求、收 Set-Cookie），此前原生侧有日志、JS 侧完全没有 ——
 * 半个链路不可见，于是出现问题只能靠猜，反复"修好了去测"却定位不到。
 *
 * JS 用法：`NativeModules.CoDiag.event('login_step', { step: 'xx', ok: 'true' })`
 * 只在 fields 里传字符串/数字/布尔，避免嵌套结构在桥上层出问题。
 */
class CoDiagModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "CoDiag"

    @ReactMethod
    fun event(name: String, fields: ReadableMap?) {
        try {
            val map = mutableMapOf<String, Any?>()
            fields?.let { m ->
                val keys = m.keySetIterator()
                while (keys.hasNextKey()) {
                    val k = keys.nextKey()
                    map[k] = when (m.getType(k)) {
                        ReadableType.Number -> m.getDouble(k).toString()
                        ReadableType.Boolean -> m.getBoolean(k).toString()
                        ReadableType.Null -> ""
                        else -> m.getString(k) ?: ""
                    }
                }
            }
            Diagnostics.event(name, map)
        } catch (t: Throwable) {
            // 诊断本身绝不能影响主流程
            android.util.Log.w("CO-DIAG", "event failed: ${t.message}")
        }
    }
}
