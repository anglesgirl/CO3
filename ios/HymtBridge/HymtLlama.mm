//
//  HymtLlama.mm
//  端侧翻译引擎（iOS）：llama.cpp + HY-MT1.5-1.8B 标准量化 GGUF
//
//  ⚠️ 为什么 iOS 不能复用 Android 那套
//  Android 用的是腾讯官方 Demo 里提取的预编译 libllama.so，它带私有 ggml 类型
//  （2bit=Q2_0C(41)、1.25bit=STQ_0(40)）—— 这些编号在 llama.cpp 主线里不存在，
//  自编库加载这种 GGUF 会因张量偏移算错而失败（实测：几十毫秒内 failed to load）。
//  官方没发 iOS 版 .so，所以 iOS 只能反过来：用 llama.cpp 主线 + 标准量化模型
//  （Q4_K_M，1.08GB）。代价是模型比 Android 大一倍，好处是精度通常还更高。
//
//  ⚠️ prompt 与采样参数必须与 Android 逐字一致，否则两端翻译质量会漂。
//  prompt 模板见 HymtModule.swift；采样参数见下方常量（腾讯官方推荐值）。
//

#import "HymtLlama.h"

#import <Foundation/Foundation.h>
#include <string>
#include <vector>
#include <mutex>
#include <atomic>

#include "llama.h"

// 采样参数：以**模型元数据自带值**为准（模型作者写进 GGUF 的推荐值）
//   general.sampling.top_k = 20
//   general.sampling.top_p = 0.8
//   general.sampling.temp  = 0.7
// 注意：腾讯 README 里写的是 top_p=0.6，与模型自带的 0.8 不一致。
// 这里取模型自带值（更贴近发布时的实际配置），若真机效果不佳再回调。
static const float kTemperature       = 0.7f;
static const float kTopP              = 0.8f;
static const int   kTopK              = 20;
static const float kRepetitionPenalty = 1.05f;
static const int   kPenaltyLastN      = 64;

@implementation HymtLlama {
    llama_model *_model;
    llama_context *_ctx;
    const llama_vocab *_vocab;
    std::mutex _mu;
    std::atomic<bool> _cancel;
}

- (instancetype)init {
    if (self = [super init]) {
        _model = NULL;
        _ctx = NULL;
        _vocab = NULL;
        _cancel = false;
    }
    return self;
}

- (void)dealloc {
    std::lock_guard<std::mutex> lk(_mu);
    if (_ctx) { llama_free(_ctx); _ctx = NULL; }
    if (_model) { llama_model_free(_model); _model = NULL; _vocab = NULL; }
}

+ (NSString *)backendInfo {
    const char *info = llama_print_system_info();
    return info ? [NSString stringWithUTF8String:info] : @"llama.cpp (info unavailable)";
}

- (BOOL)loadModelAtPath:(NSString *)path error:(NSError **)err {
    std::lock_guard<std::mutex> lk(_mu);
    if (_model) return YES;

    llama_backend_init();

    llama_model_params mp = llama_model_default_params();
    // iOS 是统一内存；把全部层交给 Metal 后端，实测比纯 CPU 快得多。
    // 若某台设备因显存受限失败，上层会拿到明确的加载错误而不是静默变慢。
    mp.n_gpu_layers = 999;

    _model = llama_model_load_from_file(path.UTF8String, mp);
    if (!_model) {
        if (err) *err = [NSError errorWithDomain:@"Hymt"
                                      code:1
                                  userInfo:@{NSLocalizedDescriptionKey: @"模型加载失败（文件损坏、下载不完整或量化类型不支持）"}];
        return NO;
    }
    _vocab = llama_model_get_vocab(_model);

    llama_context_params cp = llama_context_default_params();
    // 翻译是短文本逐段处理，2048 上下文足够，还能省内存
    cp.n_ctx = 2048;
    cp.n_batch = 512;
    // 用满物理核；上限 6 是为了避免手机过热后降频抖动
    cp.n_threads = 6;
    cp.n_threads_batch = 6;

    _ctx = llama_init_from_model(_model, cp);
    if (!_ctx) {
        if (err) *err = [NSError errorWithDomain:@"Hymt"
                                      code:1
                                  userInfo:@{NSLocalizedDescriptionKey: @"上下文创建失败（可能内存不足）"}];
        llama_model_free(_model);
        _model = NULL;
        _vocab = NULL;
        return NO;
    }
    return YES;
}

- (void)requestCancel {
    _cancel = true;
}

- (nullable NSString *)generate:(NSString *)prompt
                     maxTokens:(int)maxTokens
                       onToken:(BOOL (^)(NSString *piece))onToken {
    std::lock_guard<std::mutex> lk(_mu);
    if (!_model || !_ctx) return nil;
    _cancel = false;

    // —— 分词 ——
    const std::string p = prompt.UTF8String;
    int n = -llama_tokenize(_vocab, p.c_str(), (int)p.size(), NULL, 0, true, true);
    if (n <= 0) return nil;
    std::vector<llama_token> tokens(n);
    if (llama_tokenize(_vocab, p.c_str(), (int)p.size(), tokens.data(), n, true, true) < 0) {
        return nil;
    }

    // 每次生成前清空 KV：翻译各项互不相干，避免上一段残留污染
    llama_memory_clear(llama_get_memory(_ctx), true);

    llama_batch batch = llama_batch_get_one(tokens.data(), (int)tokens.size());
    if (llama_decode(_ctx, batch) != 0) return nil;

    // —— 采样链：严格照官方推荐值 ——
    llama_sampler_chain_params sp = llama_sampler_chain_default_params();
    sp.no_perf = true;
    llama_sampler *smpl = llama_sampler_chain_init(sp);
    llama_sampler_chain_add(smpl, llama_sampler_init_top_k(kTopK));
    llama_sampler_chain_add(smpl, llama_sampler_init_top_p(kTopP, 1));
    llama_sampler_chain_add(smpl, llama_sampler_init_temp(kTemperature));
    llama_sampler_chain_add(
        smpl,
        llama_sampler_init_penalties(
            llama_vocab_n_tokens(_vocab), kPenaltyLastN, kRepetitionPenalty, 0.0f, 0.0f));
    // 固定种子：同一段文本结果稳定，便于两端对比质量
    llama_sampler_chain_add(smpl, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    NSMutableString *out = [NSMutableString string];
    char buf[256];
    int produced = 0;

    while (produced < maxTokens) {
        if (_cancel) break;

        llama_token id = llama_sampler_sample(smpl, _ctx, -1);
        if (llama_vocab_is_eog(_vocab, id)) break;

        int wrote = llama_token_to_piece(_vocab, id, buf, sizeof(buf), 0, true);
        if (wrote > 0) {
            NSString *piece = [[NSString alloc] initWithBytes:buf
                                                       length:wrote
                                                     encoding:NSUTF8StringEncoding];
            if (piece) {
                [out appendString:piece];
                if (onToken && !onToken(piece)) break;
            }
        }

        batch = llama_batch_get_one(&id, 1);
        if (llama_decode(_ctx, batch) != 0) break;
        produced += 1;
    }

    llama_sampler_free(smpl);
    return produced > 0 ? out : nil;
}

@end
