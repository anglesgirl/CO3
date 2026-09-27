package com.co3

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import java.io.File

/**
 * 把 JS 侧的关键事件转发到统一诊断通道（[Diagnostics]）。
 *
 * 为什么需要：登录这类流程横跨 JS（取登录页、抽 CSRF token、提交表单）与原生
 * （ECH 拦截器发请求、收 Set-Cookie），此前原生侧有日志、JS 侧完全没有 ——
 * 半个链路不可见，于是出现问题只能靠猜，反复"修好了去测"却定位不到。
 *
 * JS 用法：`NativeModules.CoDiag.event('login_step', { step: 'xx', ok: 'true' })`
 * 只在 fields 里传字符串/数字/布尔，避免嵌套结构在桥上层出问题。
 *
 * 诊断导出：`exportNativeLogs()` 返回原生侧完整诊断文本；`shareText()` 把文本
 * 写临时文件并通过系统分享（微信/邮件等）发出去 —— 用户不用自己翻日志。
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

    /** 原生侧诊断全文（环境 + crash.log + 落盘 trace + 本会话缓冲）。 */
    @ReactMethod
    fun exportNativeLogs(promise: Promise) {
        try {
            promise.resolve(Diagnostics.snapshotText())
        } catch (t: Throwable) {
            promise.reject("EXPORT_FAIL", t.message ?: "export failed")
        }
    }

    /**
     * 把文本写临时文件并拉起系统分享（ACTION_SEND + FileProvider）。
     * 返回 true=已拉起分享；false=分享不可用，已复制到剪贴板兜底。
     */
    @ReactMethod
    fun shareText(title: String, text: String, promise: Promise) {
        try {
            val appCtx = ctx.applicationContext
            val dir = File(appCtx.cacheDir, "logs").apply { mkdirs() }
            val f = File(dir, "co3-diagnostics-${System.currentTimeMillis()}.txt")
            f.writeText(text)
            val uri = FileProvider.getUriForFile(appCtx, "${appCtx.packageName}.fileprovider", f)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TEXT, "CO3 诊断日志（附件，可发回给开发者）")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            appCtx.startActivity(
                Intent.createChooser(intent, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            promise.resolve(true)
        } catch (t: Throwable) {
            android.util.Log.w("CO-DIAG", "share failed: ${t.message}")
            // 兜底：复制到剪贴板，用户自己粘贴发走
            try {
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText(title, text))
                promise.resolve(false)
            } catch (t2: Throwable) {
                promise.reject("SHARE_FAIL", t2.message ?: "share failed")
            }
        }
    }
}
