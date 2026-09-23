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
    // （Conscrypt 的 provider 是懒加载，第一次真正发请求时才创建，那时 SoLoader 早已就绪）
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
    // ECH 配置落盘存储（冷启动直接复用上次的活值，不再等网关查询）
    com.co3.ech.EchState.attach(this)
    ProcessLifecycleOwner.get().lifecycle.addObserver(AppForegroundTracker)
    // ⚠️ 【绝不可在此行之前加载任何 native 库】
    // loadReactNative 里才初始化 SoLoader 与 Fresco。若在它之前调用 native 库（例如 Conscrypt），
    // 会因 SoLoader 未就绪抛 Error；一旦冒泡出去，本行不执行 → Fresco 未初始化 →
    // 渲染第一个 <Image> 时 Fresco.newDraweeControllerBuilder() 为 null → 启动即崩
    // （2026-09-11 真机实测：java.lang.NullPointerException at ReactImageManager.createViewInstance）。
    loadReactNative(this)

    // ECH 预热（必须在 loadReactNative 之后：OkHttp/DoH 是纯 JVM，但绝不冒险把网络与
    // 其他初始化塞到它前面）。后台线程跑，不阻塞启动；目的只是把 AO3 的
    // ECH 配置与干净 IP 提前取好并落盘，用户点进去时首屏不必再等这一段。
    //
    // 启动前先报告落盘状态：这能直接看出冷启动会用"旧值"还是"新值"。
    // 密钥轮换后若这里显示 hasSaved=true 且未过期，那就是拿旧密钥去握手 —— 必然失败，
    // 而旧值的 TTL 最短也被拉到 1 小时（ECH_CACHE_MIN_MS），所以这一条是排查
    // 「ECH_FAIL_CLOSED」最先该看的地方。
    runCatching {
      val warmHost = com.co3.ech.EchDoh.WARMUP_HOST
      val saved = com.co3.ech.EchState.load(warmHost)
      com.co3.Diagnostics.trace(
        "boot.echState",
        mapOf(
          "host" to warmHost,
          "hasSaved" to (saved != null),
          "bytes" to (saved?.size ?: 0),
          "note" to "hasSaved=true 表示冷启动将复用落盘的 ECH 配置（可能已是轮换前的旧密钥）"
        )
      )
    }
    Thread {
      runCatching {
        val t0 = System.currentTimeMillis()
        val ip = com.co3.ech.EchDoh.resolve(com.co3.ech.EchDoh.WARMUP_HOST)
          .firstOrNull()?.hostAddress
        android.util.Log.i("CO-ECH", "warmup resolve ok: $ip")
        com.co3.Diagnostics.trace(
          "boot.prewarm.dns",
          mapOf(
            "ok" to (ip != null), "ip" to (ip ?: "-"),
            "ms" to (System.currentTimeMillis() - t0)
          )
        )

        val t1 = System.currentTimeMillis()
        val cfg = com.co3.ech.EchDoh.echConfigList(com.co3.ech.EchDoh.WARMUP_HOST)
        android.util.Log.i("CO-ECH", "warmup ech ok: ${cfg?.size} bytes")
        com.co3.Diagnostics.trace(
          "boot.prewarm.ech",
          mapOf(
            "ok" to (cfg != null), "bytes" to (cfg?.size ?: 0),
            "ms" to (System.currentTimeMillis() - t1)
          )
        )
      }.onFailure {
        android.util.Log.w("CO-ECH", "warmup failed: ${it.message}")
        com.co3.Diagnostics.trace(
          "boot.prewarm.fail",
          mapOf("err" to "${it.javaClass.simpleName}: ${it.message}")
        )
      }
      // 预热完立刻把启动这批日志送出去 —— 冷启动那几步恰恰是最需要看清的，
      // 不能等"攒够 20 条或 4 秒"，否则用户复现一次问题却什么都没留下。
      com.co3.Diagnostics.flushAsync()
    }.start()

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
  }
}