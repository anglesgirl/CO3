//
//  HymtModule.swift
//  iOS 端侧翻译的 RN 原生模块。
//
//  ⚠️ 方法名、事件名、prompt 模板、常量都与 Android 的 HymtModule.kt 逐字对齐
//  —— JS 层（deviceTranslate.js / chapterReader.jsx）两端共用同一份代码，
//  任何一处不一致都会让某一端静默退化（表现为"翻译失败"或输出拒答文本）。
//
//  与 Android 的唯一差别是"跑哪个模型文件"：
//  Android 用官方私有量化的 2bit/1.25bit（体积省一半），iOS 用标准 Q4_K_M。
//  原因见 HymtLlama.mm 顶部注释（llama.cpp 主线不认识私有量化类型）。
//

import Foundation
import React

@objc(Hymt)
class HymtModule: RCTEventEmitter {

    // MARK: - 与 Android 逐字一致的常量

    /// 目标语言**完整名**（官方要求用完整语言名，不能填 zh 这种代码）
    private static let targetLangName = "中文"

    /// 批量翻译的段落分隔符（模型极少改动这种非常规符号，便于切回）
    private static let sep = "\n§§§\n"

    /// 切分容忍两侧空白/连续符号（模型可能吞掉换行）
    private static let sepRegex = try! NSRegularExpression(pattern: "\\s*§{3,}\\s*")

    /// 模型拒答/跑偏的典型特征串（命中即视为失败，调用方保留原文）
    private static let refusalMarks = [
        "很抱歉", "无法提供", "抱歉，我", "对不起，我",
        "I'm sorry", "I cannot", "I can't provide", "As an AI",
    ]

    /// 流式事件节流间隔（与 Android 的 80ms 一致：注入太频繁会拖慢 JS/WebView）
    private static let emitInterval: TimeInterval = 0.08

    // MARK: - 内部状态

    private let engine = HymtLlama()
    private let queue = DispatchQueue(label: "com.anglesgirl.co3.hymt", qos: .userInitiated)
    private var ready = false

    @objc
    static func moduleName() -> String! { "Hymt" }

    @objc
    static func requiresMainQueueSetup() -> Bool { return false }

    /// ⚠️ 必须声明支持的事件名，否则 RN 会丢弃 emit（真机上表现为"流式不刷新"）
    override func supportedEvents() -> [String]! {
        return ["hymt_token", "hymt_token_done"]
    }

    // hasListeners 是 RCTEventEmitter 自带的属性，RN 会按它决定是否投递事件
    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: - 模型文件

    /// 模型目录：放 Application Support 下。
    /// 不用 Documents —— 那是用户可见目录，1GB 模型不该出现在"文件"App 里；
    /// 也不用 Caches —— 系统可能在你正用着的时候把它清掉。
    private static func modelDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("hymt", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        // 1GB 模型不进 iCloud 备份（否则用户备份体积暴涨）
        var d = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? d.setResourceValues(values)
        return dir
    }

    /// 找当前可用的模型文件。
    /// ⚠️ 不硬编码文件名：JS 侧 DEVICE_MODELS 决定下载哪个量化版本，
    /// 这里只认"目录里的 gguf"，换版本（Q4_K_M / Q6_K）不用改原生代码。
    private static func modelFile() -> URL? {
        let dir = modelDir()
        let keys: [URLResourceKey] = [.fileSizeKey]
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: keys)) ?? []
        return files
            .filter { $0.pathExtension.lowercased() == "gguf" }
            .max { a, b in
                let sa = (try? a.resourceValues(forKeys: Set(keys)).fileSize) ?? 0
                let sb = (try? b.resourceValues(forKeys: Set(keys)).fileSize) ?? 0
                return sa < sb  // 多个时取最大的（=更完整的那个）
            }
    }

    private static func log(_ event: String, _ info: [String: String]) {
        // iOS 侧没有 Android 那套远程诊断通道，先落本地日志便于真机排查
        let body = info.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ")
        NSLog("[HYMT] %@ %@", event, body)
    }

    // MARK: - 模块方法

    @objc(modelExists:withResolver:withRejecter:)
    func modelExists(
        fileName: String?,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        if let name = fileName, !name.isEmpty {
            let p = Self.modelDir().appendingPathComponent(name)
            resolve(FileManager.default.fileExists(atPath: p.path))
            return
        }
        resolve(Self.modelFile() != nil)
    }

    @objc(modelPathWithResolver:withRejecter:)
    func modelPath(
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        // JS 侧会把这个路径的文件名替换成它要下载的文件名，所以返回目录下的占位路径即可
        // （目录必须存在 —— modelDir() 已保证）。
        let placeholder = Self.modelDir().appendingPathComponent("model.gguf")
        resolve(placeholder.path)
    }

    @objc(isReadyWithResolver:withRejecter:)
    func isReady(
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        resolve(ready)
    }

    // ⚠️ 内部名刻意叫 setup 而不是 initialize：ObjC 会把 `initWith...` 开头的方法
    // 当作 init 家族（要求返回对象、影响 ARC 语义）。JS 侧的名字仍是 init，
    // 靠 HymtBridge.m 里的 RCT_EXTERN_REMAP_METHOD(init, ...) 重映射过来。
    @objc(setupWithResolver:withRejecter:)
    func setup(
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        queue.async { [weak self] in
            guard let self = self else { return }
            if self.ready {
                resolve(true)
                return
            }
            guard let file = Self.modelFile() else {
                Self.log("hymt_init", ["ok": "false", "why": "no_model"])
                reject("HYMT_NO_MODEL", "model file missing", nil)
                return
            }
            let t0 = Date()
            var err: NSError?
            if !self.engine.loadModel(atPath: file.path, error: &err) {
                Self.log("hymt_init", [
                    "ok": "false", "why": "load",
                    "err": err?.localizedDescription ?? "unknown",
                ])
                reject("HYMT_LOAD_FAILED", err?.localizedDescription ?? "load failed", err)
                return
            }
            self.ready = true
            Self.log("hymt_init", [
                "ok": "true",
                "ms": String(Int(Date().timeIntervalSince(t0) * 1000)),
                "file": file.lastPathComponent,
            ])
            resolve(true)
        }
    }

    @objc(translate:maxTokens:withResolver:withRejecter:)
    func translate(
        text: String,
        maxTokens: NSNumber,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        queue.async { [weak self] in
            guard let self = self, self.ready else {
                reject("HYMT_NOT_READY", "engine not ready", nil)
                return
            }
            let mt = maxTokens.intValue > 0 ? maxTokens.intValue : 1024
            let prompt = "将以下文本翻译为\(Self.targetLangName)，注意只需要输出翻译后的结果，不要额外解释： \(text)"
            let t0 = Date()
            let out = (self.engine.generate(prompt, maxTokens: mt, onToken: nil) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let refusal = Self.refusalMarks.first { out.contains($0) }
            Self.log("hymt_translate", [
                "ok": String(!out.isEmpty && refusal == nil),
                "ms": String(Int(Date().timeIntervalSince(t0) * 1000)),
                "in_len": String(text.count),
                "out_len": String(out.count),
                "refusal": refusal ?? "-",
                "head": String(out.prefix(40)),
            ])
            if out.isEmpty || refusal != nil {
                reject("HYMT_REFUSAL", "empty=\(out.isEmpty) refusal=\(refusal ?? "-")", nil)
            } else {
                resolve(out)
            }
        }
    }

    @objc(translateBatch:maxTokens:withResolver:withRejecter:)
    func translateBatch(
        texts: [String],
        maxTokens: NSNumber,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        if texts.isEmpty {
            resolve([String]())
            return
        }
        queue.async { [weak self] in
            guard let self = self, self.ready else {
                reject("HYMT_NOT_READY", "model not ready", nil)
                return
            }
            // 多段合并成一次推理，省掉每段数百毫秒的固定开销
            let joined = texts.joined(separator: Self.sep)
            let mt = maxTokens.intValue > 0 ? maxTokens.intValue : 1024
            let prompt = "将以下文本翻译为\(Self.targetLangName)，注意只需要输出翻译后的结果，不要额外解释： \(joined)"
            let t0 = Date()
            let out = (self.engine.generate(prompt, maxTokens: mt, onToken: nil) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)

            let parts = Self.splitBySep(out)
            let refusal = Self.refusalMarks.first { out.contains($0) }
            Self.log("hymt_batch", [
                "ok": String(!out.isEmpty && refusal == nil && parts.count == texts.count),
                "ms": String(Int(Date().timeIntervalSince(t0) * 1000)),
                "n_in": String(texts.count),
                "n_out": String(parts.count),
                "refusal": refusal ?? "-",
            ])
            // 段数不符就让 JS 侧降级为逐段翻译（宁可慢，也不要错位）
            if out.isEmpty || refusal != nil || parts.count != texts.count {
                reject("HYMT_BATCH_MISMATCH",
                       "in=\(texts.count) out=\(parts.count) empty=\(out.isEmpty)", nil)
            } else {
                resolve(parts)
            }
        }
    }

    @objc(translateStream:index:maxTokens:withResolver:withRejecter:)
    func translateStream(
        text: String,
        index: NSNumber,
        maxTokens: NSNumber,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        let idx = index.intValue
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            resolve("")
            return
        }
        queue.async { [weak self] in
            guard let self = self, self.ready else {
                reject("HYMT_NOT_READY", "model not ready", nil)
                return
            }
            let mt = maxTokens.intValue > 0 ? maxTokens.intValue : 512
            let prompt = "将以下文本翻译为\(Self.targetLangName)，注意只需要输出翻译后的结果，不要额外解释： \(text)"
            let t0 = Date()
            Self.log("hymt_stream_start", ["idx": String(idx), "in_len": String(text.count)])

            // Android 发的 `full` 是"到目前为止的完整文本"，所以这里必须自行累积；
            // 直接发单 token 会让 JS 侧每 80ms 覆盖成一小段，表现为译文反复跳动。
            var accumulated = ""
            var lastEmit = Date.distantPast
            let out = self.engine.generate(prompt, maxTokens: mt) { piece in
                accumulated += piece
                let now = Date()
                if now.timeIntervalSince(lastEmit) >= Self.emitInterval {
                    lastEmit = now
                    if self.hasListeners {
                        self.sendEvent(withName: "hymt_token",
                                       body: ["index": idx, "full": accumulated])
                    }
                }
                return true
            }

            let trimmed = (out ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let refusal = Self.refusalMarks.first { trimmed.contains($0) }
            Self.log("hymt_stream", [
                "ok": String(!trimmed.isEmpty && refusal == nil),
                "idx": String(idx),
                "ms": String(Int(Date().timeIntervalSince(t0) * 1000)),
                "in_len": String(text.count),
                "out_len": String(trimmed.count),
                "refusal": refusal ?? "-",
                "out_tail": String(trimmed.suffix(40)),
            ])
            if trimmed.isEmpty || refusal != nil {
                reject("HYMT_REFUSAL", "empty=\(trimmed.isEmpty) refusal=\(refusal ?? "-")", nil)
                return
            }
            self.sendEvent(withName: "hymt_token_done", body: ["index": idx, "full": trimmed])
            resolve(trimmed)
        }
    }

    @objc(downloadModel:dest:withResolver:withRejecter:)
    func downloadModel(
        url: String,
        dest: String,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let u = URL(string: url) else {
            reject("HYMT_BAD_URL", "bad url", nil)
            return
        }
        let destURL = URL(fileURLWithPath: dest)
        try? FileManager.default.createDirectory(
            at: destURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        // ⚠️ 必须用 downloadTask：模型 1GB，dataTask 会把整份读进内存直接 OOM
        let task = URLSession.shared.downloadTask(with: u) { tmp, resp, err in
            if let err = err {
                Self.log("hymt_download", ["ok": "false", "err": err.localizedDescription])
                reject("HYMT_DOWNLOAD_FAILED", err.localizedDescription, err)
                return
            }
            guard let tmp = tmp else {
                reject("HYMT_DOWNLOAD_FAILED", "no temp file", nil)
                return
            }
            if let http = resp as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                reject("HYMT_DOWNLOAD_FAILED", "http \(http.statusCode)", nil)
                return
            }
            do {
                // 先删旧文件：半截模型加载必然失败，宁可重下也不要留个坏文件
                if FileManager.default.fileExists(atPath: destURL.path) {
                    try FileManager.default.removeItem(at: destURL)
                }
                try FileManager.default.moveItem(at: tmp, to: destURL)
                let size = (try? destURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                Self.log("hymt_download", ["ok": "true", "bytes": String(size)])
                resolve(dest)
            } catch {
                reject("HYMT_DOWNLOAD_FAILED", error.localizedDescription, error)
            }
        }
        task.resume()
    }

    @objc(downloadedBytes:withResolver:withRejecter:)
    func downloadedBytes(
        dest: String,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        let attrs = try? FileManager.default.attributesOfItem(atPath: dest)
        let size = (attrs?[.size] as? NSNumber)?.doubleValue ?? 0
        resolve(size)
    }

    /// 按分隔符切回各段；段数对不上时长度自然不符，由调用方判定降级为逐段翻译
    private static func splitBySep(_ s: String) -> [String] {
        let range = NSRange(s.startIndex..., in: s)
        var parts: [String] = []
        var last = s.startIndex
        sepRegex.enumerateMatches(in: s, options: [], range: range) { m, _, _ in
            guard let m = m, let r = Range(m.range, in: s) else { return }
            parts.append(String(s[last..<r.lowerBound])
                .trimmingCharacters(in: .whitespacesAndNewlines))
            last = r.upperBound
        }
        parts.append(String(s[last...]).trimmingCharacters(in: .whitespacesAndNewlines))
        return parts
    }
}
