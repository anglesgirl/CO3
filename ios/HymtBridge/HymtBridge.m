//
//  HymtBridge.m
//  CO3
//
//  ⚠️ 必需文件：Swift 写的 RN 原生模块，光有 @objc(Hymt) 是不够的 —— RN 的模块
//  注册表在编译期由 ObjC 宏 RCT_EXTERN_MODULE 填充。少了这个文件，App 能正常编译、
//  xcframework 也能链接，但运行时 `NativeModules.Hymt` 是 undefined，
//  deviceTranslate.js 里 `if (!Hymt) return false` 会静默返回 ——
//  表现为"iOS 上本机 AI 永远不可用"（ECH 那边踩过同样的坑，见 EchProxyBridge.m）。
//
//  方法签名必须与 HymtModule.swift 的 @objc(...) 选择器逐字对应。
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// JS 侧名字 = Hymt，Swift 类名 = HymtModule
@interface RCT_EXTERN_REMAP_MODULE(Hymt, HymtModule, RCTEventEmitter)

// @objc(modelExists:withResolver:withRejecter:)
RCT_EXTERN_METHOD(modelExists:(NSString *)fileName
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(modelPathWithResolver:withRejecter:)
RCT_EXTERN_METHOD(modelPathWithResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(isReadyWithResolver:withRejecter:)
RCT_EXTERN_METHOD(isReadyWithResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// ⚠️ 这里**不能**用 RCT_EXTERN_REMAP_METHOD(init, ...) 把它映射成 JS 的 init：
// 宏展开会撞上 ObjC 的 init 家族语法，直接报
//   "error: expected ')'" / "missing '@end'"（实测过，整个文件编不过）。
// 所以 iOS 侧公开的方法名就是 setup，由 JS 层（deviceTranslate.js）兼容两端差异：
// Android 的原生方法叫 init，iOS 叫 setup。
RCT_EXTERN_METHOD(setupWithResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(translate:maxTokens:withResolver:withRejecter:)
RCT_EXTERN_METHOD(translate:(NSString *)text
                  maxTokens:(nonnull NSNumber *)maxTokens
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(translateBatch:maxTokens:withResolver:withRejecter:)
RCT_EXTERN_METHOD(translateBatch:(NSArray *)texts
                  maxTokens:(nonnull NSNumber *)maxTokens
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(translateStream:index:maxTokens:withResolver:withRejecter:)
RCT_EXTERN_METHOD(translateStream:(NSString *)text
                  index:(nonnull NSNumber *)index
                  maxTokens:(nonnull NSNumber *)maxTokens
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(downloadModel:dest:withResolver:withRejecter:)
RCT_EXTERN_METHOD(downloadModel:(NSString *)url
                  dest:(NSString *)dest
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(downloadedBytes:withResolver:withRejecter:)
RCT_EXTERN_METHOD(downloadedBytes:(NSString *)dest
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

@end
