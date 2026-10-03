//
//  EchProxyBridge.m
//  CO3
//
//  ⚠️ 必需文件：Swift 写的 React Native 原生模块，光有 @objc(EchProxyModule)
//  是不够的 —— RN 的模块注册表在编译期由 ObjC 宏 RCT_EXTERN_MODULE 填充。
//  少了这个文件，App 能正常编译、xcframework 也能链接，但运行时
//  `NativeModules.EchProxy` 是 undefined，echKy.js 里
//  `if (!mod || typeof mod.start !== 'function') return null` 会静默返回，
//  ECH 代理永远不会启动（2026-08-11 定位到的 iOS ECH 不生效根因）。
//
//  RN 0.85 新架构（RCT_NEW_ARCH_ENABLED=1）下 legacy NativeModule 仍然
//  通过 interop 层工作，前提就是这里的注册宏存在。
//
//  方法签名必须与 EchProxyModule.swift 的 @objc(...) selector 逐字对应。
//

#import <React/RCTBridgeModule.h>

// JS 侧名字 = EchProxy，Swift 类名 = EchProxyModule
@interface RCT_EXTERN_REMAP_MODULE(EchProxy, EchProxyModule, NSObject)

// @objc(start:withDoh:withIpList:withResolver:withRejecter:)
RCT_EXTERN_METHOD(start:(nonnull NSNumber *)port
                  withDoh:(NSString *)doh
                  withIpList:(NSString *)ipList
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(stopWithResolver:withRejecter:)
RCT_EXTERN_METHOD(stopWithResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(fetchTxt:withName:withResolver:withRejecter:)
RCT_EXTERN_METHOD(fetchTxt:(NSString *)doh
                  withName:(NSString *)name
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

// @objc(statusWithResolver:withRejecter:)
RCT_EXTERN_METHOD(statusWithResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

@end
