package com.co3.hymt

import androidx.annotation.Keep
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 本机 AI 翻译模块（混元 HyMT GGUF + llama.cpp）。
 * .so 缺失时自动降级：isReady=false，上层走在线引擎。
 */
@Keep
class HymtModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val io = Executors.newSingleThreadExecutor()

    override fun getName() = "Hymt"

    private fun modelFile(): File {
        val dir = File(reactContext.filesDir, "hymt")
        val twoBit = File(dir, "Hy-MT1.5-1.8B-2bit.gguf")
        if (twoBit.exists()) return twoBit
        val small = File(dir, "Hy-MT1.5-1.8B-1.25bit.gguf")
        if (small.exists()) return small
        return twoBit
    }

    @ReactMethod
    fun isReady(promise: Promise) {
        io.execute {
            try {
                promise.resolve(HymtBridge.isLoaded && File(modelFile().absolutePath).exists() && HymtBridge.nativeIsReady())
            } catch (e: Throwable) {
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun modelExists(promise: Promise) {
        promise.resolve(modelFile().exists())
    }

    @ReactMethod
    fun modelPath(promise: Promise) {
        promise.resolve(modelFile().absolutePath)
    }

    @ReactMethod
    fun init(promise: Promise) {
        io.execute {
            try {
                if (!HymtBridge.isLoaded) {
                    promise.reject("HYMT_NO_LIB", "native library missing")
                    return@execute
                }
                val f = modelFile()
                if (!f.exists()) {
                    promise.reject("HYMT_NO_MODEL", "model file missing")
                    return@execute
                }
                val threads = Runtime.getRuntime().availableProcessors().coerceAtMost(6)
                promise.resolve(HymtBridge.nativeInit(f.absolutePath, threads))
            } catch (e: Throwable) {
                promise.reject("HYMT_INIT_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun translate(text: String, maxTokens: Int, promise: Promise) {
        io.execute {
            try {
                if (!HymtBridge.isLoaded) {
                    promise.reject("HYMT_NO_LIB", "native library missing")
                    return@execute
                }
                val out = HymtBridge.nativeTranslate(text, maxTokens)
                if (out.isNullOrEmpty()) {
                    promise.reject("HYMT_EMPTY", "empty translation")
                } else {
                    promise.resolve(out)
                }
            } catch (e: Throwable) {
                promise.reject("HYMT_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun release(promise: Promise) {
        io.execute {
            try {
                if (HymtBridge.isLoaded) HymtBridge.nativeFree()
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("HYMT_FREE_FAILED", e.message, e)
            }
        }
    }

    /**
     * 用 OkHttp 下载模型文件（流式写盘）到 destPath。
     * 进度通过 DeviceEventEmitter "HymtDownloadProgress" 事件回传
     * （{progress:0~1, bytesWritten, total}）。
     * 不走 RNFS：RNFS 的 DownloadManager/前台下载对魔搭会 Connection reset。
     */
    @ReactMethod
    fun downloadModel(url: String, destPath: String, promise: Promise) {
        io.execute {
            try {
                val client = OkHttpClient.Builder()
                    .connectTimeout(30, TimeUnit.SECONDS)
                    .readTimeout(60, TimeUnit.SECONDS)
                    .build()
                val request = Request.Builder()
                    .url(url)
                    .header(
                        "User-Agent",
                        "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 " +
                            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
                    )
                    .header("Accept", "*/*")
                    .build()

                client.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        promise.reject("HYMT_DL_FAILED", "HTTP ${resp.code}")
                        return@execute
                    }
                    val body = resp.body
                    if (body == null) {
                        promise.reject("HYMT_DL_FAILED", "empty body")
                        return@execute
                    }
                    val total = body.contentLength()
                    val target = File(destPath)
                    target.parentFile?.mkdirs()
                    val tmp = File(target.absolutePath + ".part")

                    var written = 0L
                    var lastEmit = 0L
                    body.byteStream().use { input ->
                        FileOutputStream(tmp).use { output ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n <= 0) break
                                output.write(buf, 0, n)
                                written += n
                                val now = System.currentTimeMillis()
                                if (now - lastEmit > 300) {
                                    lastEmit = now
                                    val progress =
                                        if (total > 0) written.toDouble() / total.toDouble() else 0.0
                                    emitDeviceEvent(
                                        "HymtDownloadProgress",
                                        Arguments.createMap().apply {
                                            putDouble("progress", progress)
                                            putDouble("bytesWritten", written.toDouble())
                                            putDouble("total", total.toDouble())
                                        },
                                    )
                                }
                            }
                            output.flush()
                        }
                    }
                    // 下载完成才改名，避免半截文件被当成完整模型
                    if (target.exists()) target.delete()
                    if (!tmp.renameTo(target)) {
                        tmp.copyTo(target, overwrite = true)
                        tmp.delete()
                    }
                    promise.resolve(target.absolutePath)
                }
            } catch (e: Throwable) {
                promise.reject("HYMT_DL_FAILED", e.message, e)
            }
        }
    }
}
