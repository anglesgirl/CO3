//
//  HymtLlama.h
//  iOS 端侧翻译引擎的 ObjC++ 封装头。
//
//  为什么要有这一层：Swift 调不了 llama.cpp 的 C++ API，所以用 ObjC++（.mm）
//  做桥。上层（HymtModule.swift）只依赖这里的三个方法。
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HymtLlama : NSObject

/// llama.cpp 的版本与后端信息，用于诊断「跑的到底是不是自编库」
+ (NSString *)backendInfo;

/// 加载模型。失败时 *err 带回原因（含 NSString 可读描述）。
- (BOOL)loadModelAtPath:(NSString *)path error:(NSError *_Nullable *_Nullable)err;

/// 生成。onToken 逐片回调，返回 NO 表示请求中止。
/// @return 完整文本；未产出任何 token 时返回 nil。
- (nullable NSString *)generate:(NSString *)prompt
                     maxTokens:(int)maxTokens
                       onToken:(nullable BOOL (^)(NSString *piece))onToken;

/// 请正在进行的 generate 尽早退出（用于「用户主动退出」场景）
- (void)requestCancel;

@end

NS_ASSUME_NONNULL_END
