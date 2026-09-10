// HyMT 端侧翻译 JNI 桥（PART 1/2）：llama.cpp 原生推理，只做英译中。
// 调用方（Kotlin）在后台线程调用，JNI 内不碰 UI；异常一律转成返回值。
#include <jni.h>

#ifdef HYMT_STUB
// 32 位空壳：直接返回失败，App 层降级走在线引擎。
extern "C" {
JNIEXPORT jboolean JNICALL Java_com_co3_hymt_HymtBridge_nativeInit(JNIEnv* e, jclass, jstring, jint) { return JNI_FALSE; }
JNIEXPORT jstring JNICALL Java_com_co3_hymt_HymtBridge_nativeTranslate(JNIEnv* e, jclass, jstring, jint) { return e->NewStringUTF(""); }
JNIEXPORT void JNICALL Java_com_co3_hymt_HymtBridge_nativeFree(JNIEnv*, jclass) {}
JNIEXPORT jboolean JNICALL Java_com_co3_hymt_HymtBridge_nativeIsReady(JNIEnv*, jclass) { return JNI_FALSE; }
JNIEXPORT jstring JNICALL Java_com_co3_hymt_HymtBridge_nativeLastLog(JNIEnv* e, jclass) { return e->NewStringUTF("stub-32bit"); }
}  // extern "C"
#else

#include <string>
#include <vector>

#include "llama.h"

namespace {

// 捕获 llama/ggml 的告警与错误文本，供上层上报诊断
std::string g_last_log;
bool g_log_hooked = false;

void hymt_log_cb(ggml_log_level level, const char* text, void* /*user_data*/) {
  if (!text) return;
  if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) {
    g_last_log.append(text);
    if (g_last_log.size() > 3000) {
      g_last_log.erase(0, g_last_log.size() - 3000);
    }
  }
}

struct HymtState {
  llama_model* model = nullptr;
  llama_context* ctx = nullptr;
  const llama_vocab* vocab = nullptr;
  int n_threads = 4;
};

HymtState g_state;

void free_state() {
  if (g_state.ctx) {
    llama_free(g_state.ctx);
    g_state.ctx = nullptr;
  }
  if (g_state.model) {
    llama_model_free(g_state.model);
    g_state.model = nullptr;
  }
  g_state.vocab = nullptr;
}

std::string jstring_to_utf8(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out = c ? c : "";
  if (c) env->ReleaseStringUTFChars(s, c);
  return out;
}

// 生成器：贪心采样，翻译任务确定性输出。
std::string generate(const std::string& prompt, int max_tokens) {
  const llama_vocab* vocab = g_state.vocab;
  const int n_prompt =
      -llama_tokenize(vocab, prompt.c_str(), (int)prompt.size(), nullptr, 0, true, true);
  std::vector<llama_token> prompt_tokens(-n_prompt);
  if (llama_tokenize(vocab, prompt.c_str(), (int)prompt.size(), prompt_tokens.data(),
                     (int)prompt_tokens.size(), true, true) < 0) {
    return "";
  }

  llama_batch batch = llama_batch_get_one(prompt_tokens.data(), (int)prompt_tokens.size());
  llama_sampler* sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
  llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

  std::string out;
  out.reserve(512);
  llama_token token = -1;
  int n_decoded = 0;
  bool done = false;
  while (!done && n_decoded < max_tokens) {
    if (llama_decode(g_state.ctx, batch) != 0) break;
    n_decoded++;
    token = llama_sampler_sample(sampler, g_state.ctx, -1);
    if (llama_vocab_is_eog(vocab, token)) break;
    char piece[256] = {0};
    int n = llama_token_to_piece(vocab, token, piece, sizeof(piece), 0, true);
    if (n > 0) out.append(piece, n);
    batch = llama_batch_get_one(&token, 1);
  }
  llama_sampler_free(sampler);
  llama_batch_free(batch);
  return out;
}

}  // namespace

extern "C" {

JNIEXPORT jboolean JNICALL Java_com_co3_hymt_HymtBridge_nativeInit(JNIEnv* env, jclass,
                                                                       jstring model_path,
                                                                       jint n_threads) {
  try {
    free_state();
    g_last_log.clear();
    if (!g_log_hooked) {
      llama_log_set(hymt_log_cb, nullptr);
      g_log_hooked = true;
    }
    std::string path = jstring_to_utf8(env, model_path);

    llama_model_params mparams = llama_model_default_params();
    mparams.use_mmap = true;
    mparams.use_mlock = false;
    g_state.model = llama_model_load_from_file(path.c_str(), mparams);
    if (!g_state.model) return JNI_FALSE;

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = 2048;  // 翻译段落短，2048 省内存
    cparams.n_threads = n_threads > 0 ? n_threads : 4;
    cparams.n_threads_batch = cparams.n_threads;
    g_state.ctx = llama_init_from_model(g_state.model, cparams);
    if (!g_state.ctx) {
      free_state();
      return JNI_FALSE;
    }
    g_state.vocab = llama_model_get_vocab(g_state.model);
    g_state.n_threads = cparams.n_threads;
    return JNI_TRUE;
  } catch (...) {
    free_state();
    return JNI_FALSE;
  }
}

JNIEXPORT jstring JNICALL Java_com_co3_hymt_HymtBridge_nativeTranslate(JNIEnv* env, jclass,
                                                                       jstring text,
                                                                       jint max_tokens) {
  try {
    if (!g_state.ctx) return env->NewStringUTF("");
    std::string src = jstring_to_utf8(env, text);
    if (src.empty()) return env->NewStringUTF("");

    // 拼 chat 模板：用模型自带模板（GGUF 内含），走 user/assistant 两轮。
    std::string sys = "Translate the following segment into Chinese, without additional explanation.";
    std::string user_text = sys + "\n" + src;
    // 手工组装 messages（避免 jinja 运行时依赖）：system + user
    llama_chat_message msgs[2];
    msgs[0].role = "system";
    msgs[0].content = sys.c_str();
    msgs[1].role = "user";
    msgs[1].content = src.c_str();
    char buf[8192];
    int n = llama_chat_apply_template(nullptr, msgs, 2, true, buf, sizeof(buf));
    std::string prompt = (n > 0 && n < (int)sizeof(buf)) ? std::string(buf, n) : (user_text);

    std::string out = generate(prompt, max_tokens > 0 ? max_tokens : 512);
    // 去首尾空白后返回
    size_t b = out.find_first_not_of(" \t\r\n");
    size_t e = out.find_last_not_of(" \t\r\n");
    if (b == std::string::npos) return env->NewStringUTF("");
    return env->NewStringUTF(out.substr(b, e - b + 1).c_str());
  } catch (...) {
    return env->NewStringUTF("");
  }
}

JNIEXPORT void JNICALL Java_com_co3_hymt_HymtBridge_nativeFree(JNIEnv*, jclass) {
  try {
    free_state();
  } catch (...) {
  }
}

JNIEXPORT jboolean JNICALL Java_com_co3_hymt_HymtBridge_nativeIsReady(JNIEnv*, jclass) {
  return g_state.ctx ? JNI_TRUE : JNI_FALSE;
}

// 最近一次 llama/ggml 的告警+错误文本（供上层上报诊断）
JNIEXPORT jstring JNICALL Java_com_co3_hymt_HymtBridge_nativeLastLog(JNIEnv* env, jclass) {
  if (g_last_log.empty()) return env->NewStringUTF("");
  return env->NewStringUTF(g_last_log.c_str());
}

}  // extern "C"

#endif  // HYMT_STUB
