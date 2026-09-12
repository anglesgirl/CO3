//
//  EchProxyModule.swift
//  CO3
//
//  Bridges the gomobile-built ECH proxy (package `echproxy`) to JavaScript,
//  mirroring the Android module (EchProxyModule.kt) so the same JS code path
//  (echKy.js) works on iOS.
//
//  gomobile iOS bindings (verified via gobind -lang=objc, 2026-08-06):
//    Start(listen, target, echB64, doh, ipList, cpArg string, insecure bool) error
//      -> BOOL EchproxyStart(NSString*, ..., BOOL insecure, NSError** _Nullable error)
//    Stop() error                                 -> BOOL EchproxyStop(NSError** error)
//    FetchTxt(doh, name string) (string, error)
//      -> NSString* _Nonnull EchproxyFetchTxt(NSString*, NSString*, NSError** _Nullable error)
//         (on failure: empty string + NSError set — NOT nullable!)
//    LastStatus() string                          -> NSString* _Nonnull EchproxyLastStatus()
//
//  JS usage (identical to Android):
//    import { NativeModules } from 'react-native';
//    const port = await NativeModules.EchProxy.start(0, doh, ipList);
//

import Foundation
import React
// gomobile 产出的 Echproxy.xcframework 带 Modules/module.modulemap（CI 日志已核实），
// 因此可作为 Swift module 导入。少了这行，EchproxyStart/Stop/FetchTxt/LastStatus
// 这些 C 函数在 Swift 里根本不可见（编译期就找不到符号）。
import Echproxy

@objc(EchProxyModule)
class EchProxyModule: NSObject, RCTBridgeModule {

  @objc
  static func moduleName() -> String! { "EchProxy" }

  @objc
  static func requiresMainQueueSetup() -> Bool { false }

  private let ioQueue = DispatchQueue(label: "com.anglesya.co3.echproxy")

  /// 已启动的端口。gomobile 侧 Start() 在代理已运行时返回
  /// "echproxy already running"，而 JS 侧（echKy.js）在 JS 重载 / 启动竞态后
  /// 会丢掉端口号并重试 —— 于是每次都撞 already running，永远拿不到 base，
  /// 全部请求 fail-closed（2026-08-11 iOS 真机日志实测到的现象：
  /// "[ECH] proxy failed to start in 2ms: echproxy already running"）。
  /// 记住端口，撞 already running 时直接复用；没有记录则先 Stop 再 Start。
  private static var runningPort: Int32 = 0
  private static let portLock = NSLock()

  private static func rememberPort(_ port: Int32) {
    portLock.lock(); runningPort = port; portLock.unlock()
  }

  private static func knownPort() -> Int32 {
    portLock.lock(); defer { portLock.unlock() }
    return runningPort
  }

  @objc(start:withDoh:withIpList:withResolver:withRejecter:)
  func start(
    port: NSNumber,
    doh: String,
    ipList: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    ioQueue.async {
      // 代理已经在跑（JS 重载后常见）：直接复用已知端口，不要报
      // "echproxy already running" —— 那会让 JS 永远拿不到 base。
      let known = Self.knownPort()
      if known != 0, Self.isListening(port: known) {
        resolve(known)
        return
      }

      let chosenPort: Int32
      if port.intValue != 0 {
        chosenPort = port.int32Value
      } else {
        chosenPort = Self.freePort()
      }

      let listen = "127.0.0.1:\(chosenPort)"
      let cachePath = Self.cachePath()

      var err: NSError?
      var ok = EchproxyStart(
        listen,
        "archiveofourown.org",  // target
        "",                     // echB64 (empty -> DoH / fallback + retry_configs)
        doh,                    // DoH JSON endpoint (from JS; may be empty)
        ipList,                 // preferred edge IPs (from JS; may be empty)
        cachePath,
        false,                  // insecure
        &err
      )

      // 已在运行但端口未知（例如 JS 重载、或上一次 start 的端口没记住）：
      // 停掉旧实例再启一个，比让整个 App 断网好。
      if !ok, Self.isAlreadyRunning(err) {
        var stopErr: NSError?
        _ = EchproxyStop(&stopErr)
        err = nil
        ok = EchproxyStart(
          listen, "archiveofourown.org", "", doh, ipList, cachePath, false, &err
        )
      }

      if ok {
        Self.rememberPort(chosenPort)
        resolve(chosenPort)
      } else {
        reject("ECH_START_FAILED", err?.localizedDescription ?? "unknown error", err)
      }
    }
  }

  private static func isAlreadyRunning(_ error: NSError?) -> Bool {
    guard let message = error?.localizedDescription.lowercased() else { return false }
    return message.contains("already running")
  }

  /// 端口上是否真的有人在听 —— 记住的端口在 App 被系统回收后可能已失效。
  private static func isListening(port: Int32) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(port).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    return result == 0
  }

  @objc(stopWithResolver:withRejecter:)
  func stop(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    ioQueue.async {
      var err: NSError?
      let ok = EchproxyStop(&err)
      Self.rememberPort(0)   // 端口已失效，别再复用
      if ok {
        resolve(true)
      } else {
        reject("ECH_STOP_FAILED", err?.localizedDescription ?? "unknown error", err)
      }
    }
  }

  @objc(clearSessionCookiesWithResolver:withRejecter:)
  func clearSessionCookies(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    ioQueue.async {
      // 只清 AO3 会话 cookie，保留 cf_clearance（详见 Go 侧实现）。
      EchproxyClearSessionCookies()
      resolve(true)
    }
  }

  @objc(jarInfoWithResolver:withRejecter:)
  func jarInfo(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    ioQueue.async {
      resolve(EchproxyJarInfo())
    }
  }

  @objc(fetchTxt:withName:withResolver:withRejecter:)
  func fetchTxt(
    doh: String,
    name: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    ioQueue.async {
      var err: NSError?
      // gomobile maps (string, error) to nonnull NSString* + NSError** out:
      // on failure it returns an empty string with error set.
      let result = EchproxyFetchTxt(doh, name, &err)
      if let e = err {
        reject("ECH_TXT_FAILED", e.localizedDescription, e)
      } else {
        resolve(result)
      }
    }
  }

  @objc(statusWithResolver:withRejecter:)
  func status(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let s = EchproxyLastStatus()
    resolve(s)
  }

  private static func freePort() -> Int32 {
    let socketFD = socket(AF_INET, SOCK_STREAM, 0)
    guard socketFD >= 0 else { return 0 }
    defer { close(socketFD) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = INADDR_ANY
    let bindResult = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bindResult == 0 else { return 0 }
    var actual = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let nameResult = withUnsafeMutablePointer(to: &actual) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.getsockname(socketFD, $0, &len)
      }
    }
    if nameResult != 0 { return 0 }
    return Int32(UInt16(bigEndian: actual.sin_port))
  }

  private static func cachePath() -> String {
    let dirs = NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true)
    return (dirs.first ?? NSTemporaryDirectory()) + "/ech-public-config.json"
  }
}
