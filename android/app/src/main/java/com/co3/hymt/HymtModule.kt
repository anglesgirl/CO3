package com.co3.hymt

import androidx.annotation.Keep
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.util.concurrent.Executors

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
}[truncated]