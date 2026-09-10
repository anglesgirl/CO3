package com.co3.hymt

import androidx.annotation.Keep
import com.arm.aichat.internal.InferenceEngineImpl
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 本机 AI 翻译模块。
 *
 * 推理走「官方 ARM ai-chat 引擎」的预编译库（libai-chat.so + libllama.so +
 * libggml*.so，从官方 Hy-MT Demo APK 提取，见 CI）——官方 so 的 ggml 类型编号
 * 与官方 GGUF 模型严格配套（2bit=Q2_0C / 1.25bit=STQ_0），自编 llama.cpp
 * 会因编号错位导致加载失败。故此处不自己调 llama API。
 */
@Keep
class HymtModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val io = Executors.newSingleThreadExecutor()

    @Volatile
    private var engine: InferenceEngineImpl? = null

    @Volatile
    private var ready = false

    override fun getName() = "Hymt"

    private fun modelFile(): File {
        val dir = File(reactContext.filesDir, "hymt")
        val twoBit = File(dir, "Hy-MT1.5-1.8B-2bit.gguf")
        if (twoBit.exists()) return twoBit
        return File(dir, "Hy-MT1.5-1.8B-1.25bit.gguf")
    }

    private fun ensureEngine(): InferenceEngineImpl? {
        engine?.let { return it }
        return try {
            // 诊断：确认 ggml 的 CPU 后端 so 是否真的解压到文件系统
            // （ggml 是靠扫描该目录加载后端的，只有 extractNativeLibs=true 才有）
            try {
                val libDir = File(reactContext.applicationInfo.nativeLibraryDir)
                val names = libDir.listFiles()
                    ?.map { it.name }
                    ?.filter { it.contains("ggml") || it.contains("ai-chat") || it.contains("llama") || it.contains("omp") }
                    ?.sorted()
                    ?.joinToString(",")
                    ?: "unreadable"
                com.co3.Diagnostics.event(
                    "hymt_libdir",
                    mapOf("dir" to libDir.absolutePath, "shorts" to names),
                )
            } catch (t: Throwable) {
                com.co3.Diagnostics.event("hymt_libdir", mapOf("err" to (t.message ?: "?")))
            }
            val e = InferenceEngineImpl(reactContext.applicationInfo.nativeLibraryDir)
            e.initialize()
            engine = e
            e
        } catch (t: Throwable) {
            // 官方 so 只提供 arm64-v8a：32 位设备会到这里 → 降级走在线翻译
            com.co3.Diagnostics.event(
                "hymt_engine_load",
                mapOf("ok" to "false", "err" to (t.message ?: t.javaClass.simpleName)),
            )
            null
        }
    }

    @ReactMethod
    fun modelExists(fileName: String?, promise: Promise) {
        try {
            val dir = File(reactContext.filesDir, "hymt")
            val f = if (fileName.isNullOrEmpty()) modelFile() else File(dir, fileName)
            promise.resolve(f.exists())
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun modelPath(promise: Promise) {
        promise.resolve(modelFile().absolutePath)
    }

    @ReactMethod
    fun isReady(promise: Promise) {
        promise.resolve(ready)
    }

    @ReactMethod
    fun init(promise: Promise) {
        io.execute {
            val t0 = System.currentTimeMillis()
            try {
                if (ready) {
                    promise.resolve(true)
                    return@execute
                }
                val f = modelFile()
                if (!f.exists()) {
                    com.co3.Diagnostics.event(
                        "hymt_init",
                        mapOf("ok" to "false", "why" to "no_model", "path" to f.absolutePath),
                    )
                    promise.reject("HYMT_NO_MODEL", "model file missing")
                    return@execute
                }
                val e = ensureEngine()
                if (e == null) {
                    com.co3.Diagnostics.event(
                        "hymt_init",
                        mapOf("ok" to "false", "why" to "engine_unavailable"),
                    )
                    promise.reject(
                        "HYMT_NO_ENGINE",
                        "native engine unavailable (arm64 only)",
                    )
                    return@execute
                }
                com.co3.Diagnostics.event(
                    "hymt_engine_info",
                    mapOf("info" to (e.info() ?: "").take(300)),
                )
                val rc = e.loadModel(f.absolutePath)
                if (rc != 0) {
                    com.co3.Diagnostics.event(
                        "hymt_init",
                        mapOf("ok" to "false", "why" to "load", "rc" to rc, "ms" to (System.currentTimeMillis() - t0)),
                    )
                    promise.reject("HYMT_LOAD_FAILED", "load rc=$rc")
                    return@execute
                }
                val prc = e.prepareEngine()
                if (prc != 0) {
                    com.co3.Diagnostics.event(
                        "hymt_init",
                        mapOf("ok" to "false", "why" to "prepare", "rc" to prc),
                    )
                    promise.reject("HYMT_PREPARE_FAILED", "prepare rc=$prc")
                    return@execute
                }
                // 官方 demo 不设 system prompt（只用 user prompt 模板），此处保持一致。
                ready = true
                com.co3.Diagnostics.event(
                    "hymt_init",
                    mapOf("ok" to "true", "ms" to (System.currentTimeMillis() - t0)),
                )
                promise.resolve(true)
            } catch (t: Throwable) {
                com.co3.Diagnostics.event(
                    "hymt_init",
                    mapOf("ok" to "false", "why" to (t.message ?: t.javaClass.simpleName)),
                )
                promise.reject("HYMT_INIT_FAILED", t.message, t)
            }
        }
    }

    @ReactMethod
    fun translate(text: String, maxTokens: Int, promise: Promise) {
        io.execute {
            try {
                val e = engine
                if (e == null || !ready) {
                    promise.reject("HYMT_NOT_READY", "engine not ready")
                    return@execute
                }
                val t0 = System.currentTimeMillis()
                // 官方 README 的 ZH<=>XX 权威模板（注意 target_language 要用完整语言名，
                // 如"中文"，不能填语言代码 zh，否则模型行为漂移、输出拒答文本）。
                val prompt = "将以下文本翻译为$TARGET_LANG_NAME，注意只需要输出翻译后的结果，不要额外解释： $text"
                val mt = if (maxTokens > 0) maxTokens else 1024
                val rc = e.sendUserPrompt(prompt, mt)
                if (rc != 0) {
                    com.co3.Diagnostics.event(
                        "hymt_translate",
                        mapOf("ok" to "false", "why" to "prompt", "rc" to rc),
                    )
                    promise.reject("HYMT_PROMPT_FAILED", "user prompt rc=$rc")
                    return@execute
                }
                val sb = StringBuilder()
                // 逐 token 取，直到返回 null/空串（软件上限兜底防死循环）
                var guard = 0
                val limit = mt * 2 + 16
                while (guard < limit) {
                    guard++
                    val tok = e.nextToken()
                    if (tok.isNullOrEmpty()) break
                    sb.append(tok)
                }
                val out = sb.toString().trim()
                // 模型拒答/异常输出（prompt 不当或内容触发安全）→ 作为失败上报，
                // 让 JS 侧保留原文（fail-closed：宁可不翻，也不要显示错误内容）。
                val refusal = REFUSAL_MARKS.firstOrNull { out.contains(it) }
                com.co3.Diagnostics.event(
                    "hymt_translate",
                    mapOf(
                        "ok" to (out.isNotEmpty() && refusal == null).toString(),
                        "ms" to (System.currentTimeMillis() - t0),
                        "in_len" to text.length,
                        "out_len" to out.length,
                        "tokens" to guard,
                        "refusal" to (refusal ?: "-"),
                        "head" to out.take(40),
                    ),
                )
                if (out.isEmpty() || refusal != null) {
                    promise.reject("HYMT_REFUSAL", "empty=${out.isEmpty()} refusal=${refusal ?: "-"}")
                } else {
                    promise.resolve(out)
                }
            } catch (t: Throwable) {
                com.co3.Diagnostics.event(
                    "hymt_translate",
                    mapOf("ok" to "false", "why" to (t.message ?: t.javaClass.simpleName)),
                )
                promise.reject("HYMT_FAILED", t.message, t)
            }
        }
    }

    /**
     * 批量翻译：把多段合并成**一次**推理，省掉每段约 500ms 的固定开销
     * （实测：单段 in=6 字符也要 550ms，一篇文章 150 段光固定开销就 75 秒）。
     * 输出按分隔符切回；段数不符则 reject，由 JS 侧降级为逐段翻译。
     */
    @ReactMethod
    fun translateBatch(texts: ReadableArray, maxTokens: Int, promise: Promise) {
        val n = texts.size()
        if (n <= 0) {
            promise.resolve(Arguments.createArray())
            return
        }
        val items = (0 until n).map { texts.getString(it) ?: "" }
        io.execute {
            try {
                val e = engine
                if (e == null || !ready) {
                    promise.reject("HYMT_NOT_READY", "model not ready")
                    return@execute
                }
                val t0 = System.currentTimeMillis()
                val joined = items.joinToString(SEP)
                val prompt =
                    "将以下文本翻译为$TARGET_LANG_NAME，注意只需要输出翻译后的结果，不要额外解释： $joined"
                val mt = if (maxTokens > 0) maxTokens else 1024
                val rc = e.sendUserPrompt(prompt, mt)
                if (rc != 0) {
                    com.co3.Diagnostics.event(
                        "hymt_batch",
                        mapOf("ok" to "false", "why" to "prompt", "rc" to rc),
                    )
                    promise.reject("HYMT_PROMPT_FAILED", "user prompt rc=$rc")
                    return@execute
                }
                val sb = StringBuilder()
                var guard = 0
                val limit = mt * 2 + 16
                while (guard < limit) {
                    guard++
                    val tok = e.nextToken()
                    if (tok.isNullOrEmpty()) break
                    sb.append(tok)
                }
                val out = sb.toString().trim()
                val parts = out.split(SEP_RE).map { it.trim() }
                val ok = parts.size == n && parts.none { it.isEmpty() }
                com.co3.Diagnostics.event(
                    "hymt_batch",
                    mapOf(
                        "ok" to ok.toString(),
                        "n" to n,
                        "got" to parts.size,
                        "ms" to (System.currentTimeMillis() - t0),
                        "tokens" to guard,
                        "in_all" to items.sumOf { it.length },
                        "out_all" to out.length,
                    ),
                )
                if (!ok) {
                    promise.reject("HYMT_BATCH_MISMATCH", "expect=$n got=${parts.size}")
                    return@execute
                }
                val arr = Arguments.createArray()
                parts.forEach { arr.pushString(it) }
                promise.resolve(arr)
            } catch (t: Throwable) {
                com.co3.Diagnostics.event(
                    "hymt_batch",
                    mapOf("ok" to "false", "why" to (t.message ?: t.javaClass.simpleName)),
                )
                promise.reject("HYMT_FAILED", t.message, t)
            }
        }
    }

    @ReactMethod
    fun release(promise: Promise) {
        io.execute {
            try {
                engine?.let {
                    it.unloadModel()
                    it.shutdownEngine()
                }
                engine = null
                ready = false
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("HYMT_FREE_FAILED", e.message, e)
            }
        }
    }

    /**
     * 用 OkHttp 下载模型文件（流式写盘）到 destPath，先写 .part 再改名。
     * 进度由 JS 侧轮询 [downloadedBytes] 获取。
     * 不走 RNFS：RNFS 的 DownloadManager 写不了 app 私有目录，
     * 前台模式对魔搭（阿里云 WAF）会 Connection reset。
     */
    @ReactMethod
    fun downloadModel(url: String, destPath: String, promise: Promise) {
        io.execute {
            try {
                val client = okhttp3.OkHttpClient.Builder()
                    .connectTimeout(30, TimeUnit.SECONDS)
                    .readTimeout(60, TimeUnit.SECONDS)
                    .build()
                val request = okhttp3.Request.Builder()
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

    companion object {
        /** 目标语言**完整名**（官方 README 要求用完整语言名，不能用 zh 这种代码）。 */
        private const val TARGET_LANG_NAME = "中文"

        /** 批量翻译的段落分隔符（模型极少改动这种非常规符号，便于切回）。 */
        private const val SEP = "\n§§§\n"

        /** 切分容忍两侧空白/连续符号（模型可能吞掉换行）。 */
        private val SEP_RE = Regex("\\s*§{3,}\\s*")

        /** 模型拒答/跑偏的典型特征串（命中即视为翻译失败，调用方保留原文）。 */
        private val REFUSAL_MARKS = listOf(
            "很抱歉",
            "无法提供",
            "抱歉，我",
            "对不起，我",
            "I'm sorry",
            "I cannot",
            "I can't provide",
            "As an AI",
        )
    }
}
