#ifndef ECH_HTTP_H
#define ECH_HTTP_H
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#ifdef _WIN32
#define EH_EXPORT __declspec(dllexport)
#else
#define EH_EXPORT __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
typedef struct EhClient EhClient;
typedef struct EhRequest EhRequest;
typedef struct EhOptions {
  const char *url;
  const char *method;
  const char *headers;
  const char *proxy;
  const char *ech_config;
  const char *connect_ip;
  const char *ca_pem;
  const uint8_t *body;
  size_t body_length;
  int64_t timeout_ms;
  int64_t connect_timeout_ms;
  int64_t max_response_bytes;
  bool auto_uncompress;
} EhOptions;
// Platform-neutral response event sink. The embedding host supplies this
// callback, so any runtime (JNI, Objective-C++, plain C) can drive the engine.
// Return false when the consumer is gone: the request is then cancelled.
// [data] is only valid for the duration of the call -- copy anything you keep.
// eh_request_acknowledge() is safe to call from inside this callback.
typedef bool (*EhEventCallback)(void *user_data, int32_t type, int32_t code,
                                int32_t ech_accepted, int32_t ech_retries,
                                const uint8_t *data, size_t length);
EH_EXPORT const char *eh_version(void);
EH_EXPORT EhClient *eh_client_create(void);
EH_EXPORT void eh_client_destroy(EhClient *client);
// Copies options; emits [type, code, ech_accepted, ech_retries, bytes] per event.
// Types: 1=headers, 2=body, 3=complete, 4=error. Caller-owned copies, see typedef.
EH_EXPORT EhRequest *eh_request_start(EhClient *, const EhOptions *, EhEventCallback, void *user_data);
// Releases consumed body bytes from the 256 KiB delivery budget.
EH_EXPORT void eh_request_acknowledge(EhRequest *, size_t bytes);
// Stops emitting and cancels without joining; safe from a finalizer.
EH_EXPORT void eh_request_destroy(EhRequest *);
#ifdef __cplusplus
}
#endif
#endif
