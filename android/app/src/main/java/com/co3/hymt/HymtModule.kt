package com.co3.hymt

import androidx.annotation.Keep
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
        // 优先 2bit（质量优先），其次 1.25bit。两者都是官方 GGUF，
        // 与官方预编译 libllama.so 的编号配套（2bit=Q2_0C(41)、1.25bit=STQ_0(40)）。
        val twoBit = File(dir, "Hy-MT1.5-1.8B-2bit.gguf")
        if (twoBit.exists()) return twoBit
        return File(dir, "Hy-MT1.5-1.8B-1.25bit.gguf")
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
                    com.co3.Diagnostics.event("hymt_init", mapOf("ok" to "false", "why" to "no_lib"))
                    promise.reject("HYMT_NO_LIB", "native library missing")
                    return@execute
                }
                val f = modelFile()
                if (!f.exists()) {
                    com.co3.Diagnostics.event("hymt_init", mapOf("ok" to "false", "why" to "no_model", "path" to f.absolutePath))
                    promise.reject("HYMT_NO_MODEL", "model file missing")
                    return@execute
                }
                val threads = Runtime.getRuntime().availableProcessors().coerceAtMost(6)
                val t0 = System.currentTimeMillis()
                com.co3.Diagnostics.event(
                    "hymt_init_start",
                    mapOf("path" to f.name, "mb" to (f.length() / 1048576), "threads" to threads),
                )
                val ok = HymtBridge.nativeInit(f.absolutePath, threads)
                val ms = System.currentTimeMillis() - t0
                com.co3.Diagnostics.event("hymt_init", mapOf("ok" to ok.toString(), "ms" to ms))
                promise.resolve(ok)
            } catch (e: Throwable) {
                com.co3.Diagnostics.event("hymt_init", mapOf("ok" to "false", "why" to (e.message ?: "exception")))
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
                val t0 = System.currentTimeMillis()
                val out = HymtBridge.nativeTranslate(text, maxTokens)
                val ms = System.currentTimeMillis() - t0
                if (out.isNullOrEmpty()) {
                    com.co3.Diagnostics.event(
                        "hymt_translate",
                        mapOf("ok" to "false", "why" to "empty", "ms" to ms, "in_len" to text.length),
                    )
                    promise.reject("HYMT_EMPTY", "empty translation")
                } else {
                    // 只记前几段耗时，避免日志过量
                    com.co3.Diagnostics.event(
                        "hymt_translate",
                        mapOf("ok" to "true", "ms" to ms, "in_len" to text.length, "out_len" to out.length),
                    )
                    promise.resolve(out)
                }
            } catch (e: Throwable) {
                com.co3.Diagnostics.event("hymt_translate", mapOf("ok" to "false", "why" to (e.message ?: "exception")))
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
     * 用 OkHttp 下载模型文件（流式写盘）到 destPath，先写 .part 再改名。
     * 进度由 JS 侧轮询 [downloadedBytes] 获取（不依赖 bridge 事件，新架构更稳）。
     * 不走 RNFS：RNFS 的 DownloadManager 写不了 app 私有目录，
     * 前台模式对魔搭（阿里云 WAF）会 Connection reset。
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
                    val target = File(destPath)
                    target.parentFile?.mkdirs()
                    val tmp = File(target.absolutePath + ".part")

                    body.byteStream().use { input ->
                        FileOutputStream(tmp).use { output ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n <= 0) break
                                output.write(buf, 0, n)
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

    /** 已下载字节数（.part 优先，其次正式文件），供 JS 轮询进度。 */
    @ReactMethod
    fun downloadedBytes(destPath: String, promise: Promise) {
        try {
            val part = File("$destPath.part")
            if (part.exists()) {
                promise.resolve(part.length().toDouble())
                return
            }
            val done = File(destPath)
            promise.resolve(if (done.exists()) done.length().toDouble() else 0.0)
        } catch (e: Throwable) {
            promise.resolve(0.0)
        }
    }
}
