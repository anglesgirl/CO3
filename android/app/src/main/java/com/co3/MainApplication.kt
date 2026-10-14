package com.co3

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.swmansion.rnscreens.RNScreensPackage;

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
                add(LibrarySchedulerPackage())
                add(com.co3.ech.EchWebViewPackage())
                add(com.co3.hymt.HymtPackage())
                add(object : com.facebook.react.ReactPackage {
                    override fun createNativeModules(reactContext: com.facebook.react.bridge.ReactApplicationContext) = listOf<com.facebook.react.bridge.NativeModule>(
                        CoCookieModule(reactContext),
                        CoDiagModule(reactContext),
                    )
                    override fun createViewManagers(reactContext: com.facebook.react.bridge.ReactApplicationContext) = emptyList<com.facebook.react.uimanager.ViewManager<*,*>>()
                })
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // Hook React Native OkHttp：这里只注册工厂类，**不触发任何 native 初始化**
    // （Go aar 由 MainApplication 后台线程启动，工厂只在真正发请求时读端口）
    try {
        val provider = Class.forName("com.facebook.react.modules.network.OkHttpClientProvider")
        val method = provider.getMethod("setOkHttpClientFactory", Class.forName("com.facebook.react.modules.network.OkHttpClientFactory"))
        val factory = com.co3.ech.ReactNativeEchFactory()
        method.invoke(null, factory)
        android.util.Log.i("CO-ECH", "OkHttpClientProvider patched")
    } catch (t: Throwable) {
        // 必须捕 Throwable：native 库未就绪时抛的是 Error，catch(Exception) 捕不到
        android.util.Log.w("CO-ECH", "OkHttp hook failed: " + t.message)
    }
    com.co3.Diagnostics.initialize(this)
    com.co3.ech.EchState.attach(this)
    ProcessLifecycleOwner.get().lifecycle.addObserver(AppForegroundTracker)
    // ⚠️ 【绝不可在此行之前加载任何 native 库】
    // loadReactNative 里才初始化 SoLoader 与 Fresco。若在它之前调用 native 库（例如 Go aar），
    // 会因 SoLoader 未就绪抛 Error；一旦冒泡出去，本行不执行 → Fresco 未初始化 →
    // 渲染第一个 <Image> 时 Fresco.newDraweeControllerBuilder() 为 null → 启动即崩
    // （2026-09-11 真机实测：java.lang.NullPointerException at ReactImageManager.createViewInstance）。
    loadReactNative(this)

    // ECH 冷启动预热在下面的后台线程里做（DomesticDoh.echConfigList，走国内 DoH）。
    // 注：2026-10-14 删掉了这里的 EchDoh.prefetch("archiveofourown.org")——那是旧网关
    // DoH 路径的预热，新架构热路径（ConscryptEch→EchDoh.echConfigList→DomesticDoh）
    // 根本不读它，白白每次冷启动多一次网关请求；旧网关只在 DomesticDoh 失败时兜底。

    // 2026-10-13 新架构：首次启动扫描可用 CF IP（DoH 被封后不再依赖 DoH 解析）。
    // 有缓存则跳过；无缓存时后台静默扫描，不阻塞启动。
    Thread {
        runCatching {
            val ctx = applicationContext
            if (com.co3.ech.CfIpScanner.loadIps(ctx).isEmpty()) {
                android.util.Log.i("CO-ECH", "首次启动：开始扫描可用 CF IP")
                com.co3.Diagnostics.trace("boot.cfscan.begin", emptyMap())
                val ips = kotlinx.coroutines.runBlocking {
                    com.co3.ech.CfIpScanner.scanAndSave(ctx)
                }
                com.co3.Diagnostics.trace("boot.cfscan.done", mapOf("count" to ips.size))
                android.util.Log.i("CO-ECH", "CF IP 扫描完成：${ips.size} 个可用")
            }
            // 预热 ECH（国内 DoH 取 cloudflare-ech.com，缓存 1 小时）
            com.co3.ech.DomesticDoh.echConfigList()
        }.onFailure {
            android.util.Log.w("CO-ECH", "CF IP 扫描失败: ${it.message}")
        }
    }.apply {
        priority = Thread.MIN_PRIORITY
        start()
    }
    Thread {
        try {
            val ok = com.co3.ech.ConscryptEch.install()
            com.co3.Diagnostics.trace("boot.prewarm.conscrypt", mapOf("result" to if (ok) "ok" else "fail"))
        } catch (t: Throwable) {
            com.co3.Diagnostics.trace("boot.prewarm.conscrypt", mapOf("result" to "fail", "err" to (t.message ?: "")))
        }
    }.apply {
        priority = Thread.MIN_PRIORITY
        start()
    }
    com.co3.Diagnostics.flushAsync()

    // 【再兜一道】上面那条只保证"不会因为提前加载 native 而跳过 loadReactNative"。
    // 真机仍在冷启动时偶发同一个崩溃，栈顶是 Fabric 的**预分配**路径：
    //   PreAllocateViewMountItem.execute → SurfaceMountingManager.preallocateView
    //   → ReactImageManager.createViewInstance → Fresco.newDraweeControllerBuilder 为 null
    // 即：首帧预分配视图抢在了 Fresco 初始化之前（loadReactNative 内部才会初始化它）。
    // 这里显式确认一次：已初始化则完全空操作（不覆盖 RN 自己的 pipeline 配置），
    // 未初始化才补上；整个判断包在 try 里，任何异常都不影响启动。
    try {
      val frescoClass = Class.forName("com.facebook.drawee.backends.pipeline.Fresco")
      val hasInit = frescoClass.getMethod("hasBeenInitialized").invoke(null) as? Boolean ?: false
      if (!hasInit) {
        frescoClass.getMethod("initialize", android.content.Context::class.java).invoke(null, this)
        android.util.Log.i("CO-ECH", "Fresco was not initialized; initialized in Application")
      }
    } catch (t: Throwable) {
      android.util.Log.w("CO-ECH", "Fresco ensure failed: " + t.message)
    }

    // 进程内 Go ECH 本地转发服务：WebView 浏览/登录统一走 http://127.0.0.1:<port>
    // （明文仅本机回环），转发服务还原 Host/SNI/Origin 后经 Go ECH 发往 AO3。
    // 后台线程启动（幂等）；Go 库跑在 App 自身进程内（同进程内嵌，非独立进程，
    // 不存在"单独 Go 进程被系统回收"）。
    runCatching {
      // Android 侧请求已全部改走 ech_http 引擎（不监听端口，因此没有「代理没起来 /
      // 配置没生效 / 端口对不上」这一整类问题），这里不再启动本地 Go 代理。
      // 引擎就绪由调用方保证（CoWebViewHelper / EchEngineInterceptor），
      // DoH 配置由 JS 在 initEch 时落盘给 EchDohConfig。
      android.util.Log.i("CO-ECH", "ECH 走 ech_http 引擎，不再启动本地 Go 代理")
    }
  }
}