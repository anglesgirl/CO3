//
//  EchLogger.swift
//  CO3 (EchProxyBridge pod)
//
//  iOS 侧诊断上报：直接 POST 到我们自己的接收服务（log.anglesgirl.eu.org）。
//
//  为什么原生要单独报一份（而不是全靠 JS 的 remoteLog）：
//  桥没注册、gomobile Start 报错、端口复用失败这些事发生在 JS 拿到控制权之前，
//  有的甚至连 JS 都不知道（EchProxy 是 undefined 时 JS 只能报"模块不存在"，
//  报不出原因）。原生直接上报才能把「ECH 从来没起来」和「起来了但握手失败」分开。
//
//  与 JS 端（main/utils/remoteLog.js）共用同一个接收服务与 app 名（co3-ios），
//  事件名以 native_ 前缀区分。
//
//  约束（接收端在 /root/.hermes/scripts/diagnostics_receiver.py）：
//  一条 POST 一个事件、url/cookie/token 等键整体脱敏（所以别用这些当字段名）、
//  限流 120 次/分钟、失败静默且不重试。
//

import Foundation

@objc(EchLogger)
final class EchLogger: NSObject {

  static let shared = EchLogger()

  private let endpoint = URL(string: "https://log.anglesgirl.eu.org/v1/events")!
  private let appName = "co3-ios"
  private let queue = DispatchQueue(label: "com.anglesya.co3.ech.logger")
  private let minInterval: TimeInterval = 1.2 // ≈50 条/分钟，给接收端限流留余量
  private var lastSentAt = Date.distantPast
  private let session: URLSession

  /// 接收端会把同名的键整体脱敏 —— 这里直接不送，换个名字重发（域名一律用 host）
  private static let sensitiveKeys: Set<String> = [
    "url", "full_url", "cookie", "cookies", "token", "password", "secret",
    "authorization", "request_body", "response_body",
  ]

  private override init() {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 8
    cfg.waitsForConnectivity = false
    session = URLSession(configuration: cfg)
    super.init()
    // 原生崩溃上报（对齐 Android 侧 Diagnostics.kt 的 app_crash）。
    // 只覆盖「本类被初始化之后」的崩溃；更早的崩溃由 JS 侧处理器兜。
    NSSetUncaughtExceptionHandler { exception in
      EchLogger.log("app_crash_native", [
        "name": exception.name.rawValue,
        "reason": (exception.reason ?? "").prefix(300).description,
        "stack": exception.callStackSymbols.prefix(12).joined(separator: "\n"),
      ])
      // 崩溃路径上尽力而为：给上报线程一点时间
      Thread.sleep(forTimeInterval: 1.5)
    }
  }

  /// 记一条事件。同步返回，绝不阻塞调用方，也绝不抛错。
  static func log(_ event: String, _ fields: [String: Any] = [:]) {
    shared.enqueue(event, fields)
  }

  private func enqueue(_ event: String, _ fields: [String: Any]) {
    let safe = Self.sanitize(fields)
    queue.async { [weak self] in
      guard let self = self else { return }
      let wait = self.minInterval - Date().timeIntervalSince(self.lastSentAt)
      if wait > 0 { Thread.sleep(forTimeInterval: wait) }
      self.lastSentAt = Date()

      let payload: [String: Any] = [
        "app": self.appName,
        "event": String(event.prefix(64)),
        "timestamp": ISO8601DateFormatter().string(from: Date()),
        "fields": safe,
      ]
      guard JSONSerialization.isValidJSONObject(payload),
            let body = try? JSONSerialization.data(withJSONObject: payload) else { return }

      var request = URLRequest(url: self.endpoint)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
      // 静默：上报失败无所谓，绝不重试（别把自己的服务打爆，也别拖慢业务）
      self.session.dataTask(with: request) { _, _, _ in }.resume()
    }
  }

  private static func sanitize(_ fields: [String: Any]) -> [String: Any] {
    var out: [String: Any] = [:]
    for (key, value) in fields {
      if sensitiveKeys.contains(key.lowercased()) { continue }
      switch value {
      case let s as String:
        out[key] = s.count > 400 ? String(s.prefix(400)) + "…" : s
      case let n as NSNumber:
        out[key] = n
      case let b as Bool:
        out[key] = b
      default:
        let text = String(describing: value)
        out[key] = text.count > 400 ? String(text.prefix(400)) + "…" : text
      }
    }
    return out
  }
}
