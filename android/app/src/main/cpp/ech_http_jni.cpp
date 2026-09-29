/*
 * CO3 的 ech_http JNI 桥（Android）。
 *
 * 引擎（去 Dart 化后的 ech_http C++ 核心）在自己的工作线程上推进请求，通过
 * 回调投递事件；本桥把它包装成一个**同步** JNI 调用，供 OkHttp 拦截器这类
 * 命令式调用点直接使用 —— 这正是它取代「本地 Go 代理 + URL 重写」的关键：
 * 不再需要监听 127.0.0.1 端口，TLS/ECH 全在同一进程内完成。
 *
 * 三条必须守住的约束：
 *  1. 回调返回前必须把数据拷走（引擎只保证 data 在回调期间有效）；
 *  2. 回调内调用 eh_request_acknowledge() 归还 256 KiB 流控额度是**安全的**
 *     （引擎已改为「回调前解锁」；早期版本持锁回调会导致宿主一 ack 就自锁挂死）；
 *  3. 只有收到完成/错误事件后才可以销毁累加器。引擎自身有 timeout_ms 硬超时，
 *     这里多给 5 秒余量；万一仍未结束就**不释放**（宁可少量泄漏，也绝不让工作
 *     线程回调到已释放的内存）。
 */
#include <jni.h>

#include <android/log.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "ech_http.h"

#define TAG "CO3-ECHHTTP"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

constexpr const char *kResponseClass = "com/co3/ech/EchHttpNative$Response";
constexpr const char *kResponseSig = "(ILjava/lang/String;[BZI)V";
constexpr int64_t kWaitGraceMs = 5000;

std::string ToUtf8(JNIEnv *env, jstring value) {
  if (value == nullptr) return {};
  const char *chars = env->GetStringUTFChars(value, nullptr);
  std::string out = (chars != nullptr) ? chars : "";
  if (chars != nullptr) env->ReleaseStringUTFChars(value, chars);
  return out;
}

// 引擎工作线程写入；调用线程等待 finished 后读取。
struct Accumulator {
  std::mutex mutex;
  std::condition_variable cv;
  bool finished = false;
  int status = 0;
  int ech_accepted = -1;
  int ech_retries = -1;
  int final_code = -1;
  std::string headers;
  std::string error;
  std::vector<uint8_t> body;
  std::atomic<EhRequest *> request{nullptr};
};

// 事件类型: 1=响应头 2=响应体 3=完成 4=错误
bool OnEvent(void *user_data, int32_t type, int32_t code, int32_t ech_accepted,
             int32_t ech_retries, const uint8_t *data, size_t length) {
  auto *acc = static_cast<Accumulator *>(user_data);
  std::lock_guard<std::mutex> lock(acc->mutex);
  switch (type) {
    case 1:
      acc->status = code;
      acc->ech_accepted = ech_accepted;
      acc->ech_retries = ech_retries;
      acc->headers.assign(reinterpret_cast<const char *>(data), length);
      break;
    case 2:
      acc->body.insert(acc->body.end(), data, data + length);
      // 回调内归还接收额度是安全的（引擎在调用回调前已释放自身互斥量）
      if (EhRequest *req = acc->request.load()) {
        eh_request_acknowledge(req, length);
      }
      break;
    case 3:
      acc->final_code = code;
      acc->finished = true;
      acc->cv.notify_all();
      break;
    case 4:
      acc->final_code = (code != 0) ? code : -2;
      acc->error.assign(reinterpret_cast<const char *>(data), length);
      acc->finished = true;
      acc->cv.notify_all();
      break;
    default:
      break;
  }
  return true;
}

// 未能在宽限期内结束的请求：句柄与累加器一起暂存，等下次调用时回收已完成者。
// 引擎的 worker 线程自己持有 RequestState 的 shared_ptr，所以释放 EhRequest
// 句柄总是安全的；但 worker 可能仍会回调，累加器必须留到它真正结束。
struct Orphan {
  Accumulator *acc;
  EhRequest *request;
};

std::mutex g_orphan_mutex;
std::vector<Orphan> g_orphans;

void ReapOrphans() {
  std::lock_guard<std::mutex> guard(g_orphan_mutex);
  auto it = g_orphans.begin();
  while (it != g_orphans.end()) {
    bool finished = false;
    {
      std::lock_guard<std::mutex> lock(it->acc->mutex);
      finished = it->acc->finished;
    }
    if (finished) {
      eh_request_destroy(it->request);
      delete it->acc;
      it = g_orphans.erase(it);
    } else {
      ++it;
    }
  }
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_co3_ech_EchHttpNative_nativeVersion(JNIEnv *env, jclass) {
  return env->NewStringUTF(eh_version());
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_co3_ech_EchHttpNative_nativeRequest(JNIEnv *env, jclass, jstring j_url,
                                             jstring j_method, jstring j_headers,
                                             jstring j_ech_config,
                                             jstring j_connect_ip,
                                             jlong timeout_ms,
                                             jlong max_response_bytes) {
  if (j_url == nullptr) return nullptr;

  const std::string url = ToUtf8(env, j_url);
  const std::string method = ToUtf8(env, j_method);
  const std::string headers = ToUtf8(env, j_headers);
  const std::string ech_config = ToUtf8(env, j_ech_config);
  const std::string connect_ip = ToUtf8(env, j_connect_ip);
  if (url.empty()) {
    LOGE("nativeRequest: url 为空");
    return nullptr;
  }

  ReapOrphans();

  EhClient *client = eh_client_create();
  if (client == nullptr) {
    LOGE("nativeRequest: eh_client_create 失败");
    return nullptr;
  }

  auto *acc = new Accumulator();

  EhOptions options;
  memset(&options, 0, sizeof(options));
  options.url = url.c_str();
  options.method = method.empty() ? "GET" : method.c_str();
  options.headers = headers.empty() ? nullptr : headers.c_str();
  // ech_config 为空 = 不启用 ECH（仅供对照/排障，AO3 必须带 ECH）
  options.ech_config = ech_config.empty() ? nullptr : ech_config.c_str();
  options.connect_ip = connect_ip.empty() ? nullptr : connect_ip.c_str();
  options.timeout_ms = timeout_ms;
  options.connect_timeout_ms = std::min<int64_t>(timeout_ms, 15000);
  options.max_response_bytes = max_response_bytes;
  options.auto_uncompress = true;

  EhRequest *request = eh_request_start(client, &options, OnEvent, acc);
  if (request == nullptr) {
    LOGE("nativeRequest: eh_request_start 返回空（参数或 ECH 配置被拒）");
    delete acc;
    eh_client_destroy(client);
    return nullptr;
  }
  acc->request.store(request);

  {
    std::unique_lock<std::mutex> lock(acc->mutex);
    acc->cv.wait_for(lock, std::chrono::milliseconds(timeout_ms + kWaitGraceMs),
                     [acc] { return acc->finished; });
  }

  jobject result = nullptr;
  bool finished = false;
  {
    std::lock_guard<std::mutex> lock(acc->mutex);
    finished = acc->finished;
    if (finished) {
      // 完成事件是引擎投递的最后一个事件，此后工作线程不再触碰累加器
      jstring j_headers = env->NewStringUTF(acc->headers.c_str());
      jbyteArray j_body = env->NewByteArray(static_cast<jsize>(acc->body.size()));
      if (j_body != nullptr && !acc->body.empty()) {
        env->SetByteArrayRegion(j_body, 0, static_cast<jsize>(acc->body.size()),
                                reinterpret_cast<const jbyte *>(acc->body.data()));
      }
      jclass cls = env->FindClass(kResponseClass);
      if (cls != nullptr && j_headers != nullptr && j_body != nullptr) {
        jmethodID ctor = env->GetMethodID(cls, "<init>", kResponseSig);
        if (ctor != nullptr) {
          result = env->NewObject(cls, ctor, static_cast<jint>(acc->status),
                                  j_headers, j_body,
                                  static_cast<jboolean>(acc->ech_accepted == 1),
                                  static_cast<jint>(acc->ech_retries));
        } else {
          LOGE("nativeRequest: 找不到 Response 构造器 %s", kResponseSig);
        }
      } else {
        LOGE("nativeRequest: 找不到 %s 或分配失败", kResponseClass);
      }
      if (result == nullptr) {
        LOGE("nativeRequest: 构造 Java Response 失败");
      } else if (acc->final_code != 0) {
        // 引擎侧失败（如 ECH 配置被拒）：把原因留在日志里，Kotlin 侧看到 status=0
        LOGI("nativeRequest: 未成功 final_code=%d err=%s", acc->final_code,
             acc->error.c_str());
      }
    }
  }

  if (finished) {
    // 完成事件是最后一个事件，worker 不会再回调；句柄由持有者释放
    eh_request_destroy(request);
    delete acc;
  } else {
    LOGE("nativeRequest: 超过 %lld ms 仍未结束，暂存句柄与累加器避免悬垂",
         static_cast<long long>(timeout_ms + kWaitGraceMs));
    std::lock_guard<std::mutex> guard(g_orphan_mutex);
    g_orphans.push_back(Orphan{acc, request});
  }

  // 销毁 client 是安全的：worker 通过 shared_ptr 独立持有连接池
  eh_client_destroy(client);
  return result;
}
