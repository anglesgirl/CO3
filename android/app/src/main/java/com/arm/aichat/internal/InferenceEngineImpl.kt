package com.arm.aichat.internal

/**
 * 官方 ARM AI-Chat 推理引擎的 Kotlin 侧壳。
 *
 * 这个类名/包名/方法签名必须与官方 APK 里的一致：
 * 官方 libai-chat.so 导出的 JNI 符号就是
 *   Java_com_arm_aichat_internal_InferenceEngineImpl_<method>
 * 所以只要我们声明同名 native 方法，运行时即可绑定到官方实现。
 *
 * 调用协议（由官方 dex 字节码还原）：
 *   System.loadLibrary("ai-chat")
 *   engine = InferenceEngineImpl(applicationInfo.nativeLibraryDir)
 *   engine.init(nativeLibraryDir)
 *   engine.load(modelPath)        // 0 = 成功
 *   engine.prepare()              // 0 = 成功
 *   engine.processSystemPrompt(p) // 必须在 load 之后立刻调用
 *   engine.processUserPrompt(text, maxTokens)
 *   循环 engine.generateNextToken() 直到返回 null/空
 *   engine.unload(); engine.shutdown()
 */
class InferenceEngineImpl(nativeLibraryDir: String) {

    private val nativeLibraryDir: String = nativeLibraryDir

    init {
        System.loadLibrary("ai-chat")
    }

    private external fun init(nativeLibraryDir: String)
    private external fun load(modelPath: String): Int
    private external fun prepare(): Int
    private external fun processSystemPrompt(prompt: String): Int
    private external fun processUserPrompt(prompt: String, maxTokens: Int): Int
    private external fun generateNextToken(): String?
    private external fun unload()
    private external fun shutdown()
    private external fun systemInfo(): String?
    private external fun benchModel(pp: Int, tg: Int, pl: Int, nr: Int): String?

    // ---- 公开包装（供 CO3 调用）----

    /** 初始化引擎（参数与官方一致：native 库目录）。 */
    fun initialize() {
        init(nativeLibraryDir)
    }

    /** 引擎系统信息（诊断用）。 */
    fun info(): String? = try {
        systemInfo()
    } catch (e: Throwable) {
        null
    }

    /** 加载模型，返回 0 表示成功。 */
    fun loadModel(path: String): Int = load(path)

    /** 准备资源，返回 0 表示成功。 */
    fun prepareEngine(): Int = prepare()

    fun setSystemPrompt(prompt: String): Int = processSystemPrompt(prompt)

    fun sendUserPrompt(prompt: String, maxTokens: Int): Int =
        processUserPrompt(prompt, maxTokens)

    /** 取下一个 token；返回 null 或空串表示生成结束。 */
    fun nextToken(): String? = try {
        generateNextToken()
    } catch (e: Throwable) {
        null
    }

    fun unloadModel() {
        try {
            unload()
        } catch (_: Throwable) {
        }
    }

    fun shutdownEngine() {
        try {
            shutdown()
        } catch (_: Throwable) {
        }
    }
}
