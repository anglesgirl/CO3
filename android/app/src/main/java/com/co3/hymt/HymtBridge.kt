package com.co3.hymt

/**
 * JNI 声明：libhymt（llama.cpp）。loadLibrary 失败不抛，由 isLoaded 标记降级。
 */
internal object HymtBridge {
    var isLoaded = false
        private set

    init {
        try {
            System.loadLibrary("hymt")
            isLoaded = true
        } catch (e: Throwable) {
            isLoaded = false
        }
    }

    external fun nativeInit(modelPath: String, nThreads: Int): Boolean
    external fun nativeTranslate(text: String, maxTokens: Int): String?
    external fun nativeFree()
    external fun nativeIsReady(): Boolean
}
