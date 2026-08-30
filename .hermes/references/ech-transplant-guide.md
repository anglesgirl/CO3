# ECH 移植指南 — Han1meViewer 已验证方案（给 AI 看）

> **一句话**：直接搬 `Han1mePlus 的 curl+BoringSSL` 完整链路，别自己重写 probe / Conscrypt / ech-tls-android。
> Han1meViewer 生产环境已验证，CO3 直接套用即可。

## 1. 结论先行（别瞎搞）

| 路线 | 结果 | 原因 |
|---|---|---|
| **Conscrypt 2.7-alpha** | ❌ 完全无效 | `ConscryptNetworkSecurityPolicy.getDomainEncryptionMode()` 硬编码 `UNKNOWN` → `SSL_set1_ech_config_list` 永不调用 |
| **ech-tls-android AAR (probe)** | ⚠️ 半成品 | 只有 `EchNative.probe()` 能测连通，**没有 SSLSocketFactory**，发不了业务请求 |
| **Han1mePlus curl+BoringSSL** | ✅ 唯一生产可用 | native 层完整做 HTTP（DoH 查 ECHConfig + TLS1.3 + ECH 握手 + 发请求），绕过 OkHttp，直接返回 Response |

**AI 铁律：新 App 要 ECH，直接抄第 3 行，别碰前两行。**

## 2. 核心文件清单（3 个必搬 + 1 个 so）

源仓库：`/tmp/han1me-upstream`（用户 fork `anglesgirl/Han1meViewer`，分支 `diagnostics-foundation`）

```
app/src/main/assets/han1meplus/arm64-v8a/libhan1me_ech.so  # 3.1M，已编译，勿重编
app/src/main/java/com/liar/han1meplus/EchHttpClient.kt      # JNI bridge，包名必须 com.liar.han1meplus
app/src/main/java/com/yenaly/han1meviewer/logic/network/EchInterceptor.kt  # 模板，改域名即可
app/src/main/java/com/yenaly/han1meviewer/logic/network/DohConfig.kt       # 可简化为硬编码
```

**CO3 移植后**：
```
android/app/src/main/assets/han1meplus/arm64-v8a/libhan1me_ech.so
android/app/src/main/java/com/liar/han1meplus/EchHttpClient.kt  # 原样拷，@Keep，isLoaded 单例
android/app/src/main/java/com/co3/ech/CoEchInterceptor.kt       # AO3 版拦截器
android/app/src/main/java/com/co3/ech/ReactNativeEchFactory.kt  # RN 专用，钩 OkHttpClientProvider
```

## 3. 移植步骤（5 步，10 分钟）

### Step 1: 拷 so 到 assets
```bash
mkdir -p android/app/src/main/assets/han1meplus/arm64-v8a
cp /tmp/han1me-upstream/app/src/main/assets/han1meplus/arm64-v8a/libhan1me_ech.so \
   android/app/src/main/assets/han1meplus/arm64-v8a/
```
- 仅 arm64-v8a，用户手机小米 2604FRK1EC 就是 arm64
- 勿改路径，`EchHttpClient.init()` 写死 `assets.open("han1meplus/$abi/libhan1me_ech.so")`

### Step 2: 拷 EchHttpClient.kt（原样不动）
- 包名 `com.liar.han1meplus` 必须保留，和 so 内 JNI 注册名一致
- `@Keep` 不能删
- `init(context)` 会把 so 从 assets 拷到 `filesDir/han1me_ech_arm64-v8a.so` 再 `System.load()`

### Step 3: 写 CoEchInterceptor.kt（改 2 处）
照 `EchInterceptor.kt` 抄，改：
1. `hanimeHosts` → `setOf("archiveofourown.org", "www.archiveofourown.org")` + `endsWith(".archiveofourown.org")`
2. `DOH_URL = "https://82sew1c85i.cloudflare-gateway.com/dns-query"` 
   `DOH_RESOLVE = "82sew1c85i.cloudflare-gateway.com:443:162.159.36.20,162.159.36.5"`
- 逻辑：`shouldIntercept()` 判域名 → 收集 header/body → `EchHttpClient.request(method, url, headers, body, dohUrl, dohResolve)` → 解析返回 JSON(`statusCode/body(echStatus/headers)→ 构 Response
- 失败先 `fallback chain.proceed()` 保可用，验证 ECH 生效后再改 fail-closed

### Step 4: RN 钩子 ReactNativeEchFactory.kt
```kotlin
class ReactNativeEchFactory : OkHttpClientFactory {
    override fun createNewNetworkModuleClient(): OkHttpClient =
        OkHttpClient.Builder()
            .cookieJar(ReactCookieJarContainer())
            .addInterceptor(CoEchInterceptor())
            .build()
}
```

### Step 5: MainApplication.onCreate() 初始化
```kotlin
override fun onCreate() {
    super.onCreate()
    EchHttpClient.init(this) // 先 load so
    try {
        val p = Class.forName("com.facebook.react.modules.network.OkHttpClientProvider")
        val m = p.getMethod("setOkHttpClientFactory", Class.forName("com.facebook.react.modules.network.OkHttpClientFactory"))
        m.invoke(null, ReactNativeEchFactory())
    } catch (e: Exception) { Log.w("CO-ECH", "hook fail: ${e.message}") }
    // ...原有 loadReactNative
}
```
- 反射钩 RN 的 `OkHttpClientProvider`，让所有 JS `fetch` 自动走 ECH
- WebView 的请求不走 OkHttp，需另在 `WebViewClient.shouldInterceptRequest` 调 `EchHttpClient`（二期）

## 4. 关键坑（踩过才会懂）

1. **别动 build.gradle**：CO3 原生 `dependencies` 已够，只加 assets/so，不加 aar。`fileTree(libs)` 留空也无碍，别加 `flatDir` 等花活
2. **so 包名死锁**：`EchHttpClient` 包名改一个字母，JNI 就 `UnsatisfiedLinkError`
3. **DoH 必须钉 IP**：`dohResolve` 把 `82sew1c85i...` 钉到 `162.159.36.20` 防污染，否则 DoH 自己就被墙
4. **ECH 判据**：看 native 返回 JSON 的 `echStatus`，不是看证书。`SSL_ech_accepted` 在 so 内部已校验
5. **系统证书**：so 内部用 `CAPATH=/system/etc/security/cacerts`，无须额外 ca
6. **TLS1.3 强制**：so 内部已强制 TLS1.3，勿改
7. **Actions 构建**：统一走 GitHub Actions，不用 upload-artifact，发 Release；CO3 是公开仓库，分钟数无限

## 5. 验证

- Logcat 搜 `CO-ECH`：`EchHttpClient init ok` + `OkHttpClientProvider patched` + `ECH OK archiveofourown.org -> 200`
- 网络：AO3 在 GFW 下能加载作品（之前 `Network request failed` 消失）
- 日志上报：`log.anglesgirl.eu.org/v1/events` 看 `ech_probe_result` / `echStatus`

## 6. 为什么不重写

- so 是 Han1mePlus 已编译的 BoringSSL+curl（`USE_ECH=ON`），含 `ECHConfig` 兜底（无 ech 时用 `store.ubisoft.com` 共享 config，同属 cloudflare-ech.com 前端）和重试逻辑
- 重写一遍要处理：DoH wire-format、SVCB key=5 解析、public_name 校验、ECH_REJECTED 重试，全部已在 so 内做完

> **AI 看到此文档：直接执行 Step 1-5，别发明新方案。**
