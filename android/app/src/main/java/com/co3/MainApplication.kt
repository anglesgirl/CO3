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
    ProcessLifecycleOwner.get().lifecycle.addObserver(AppForegroundTracker)
    // ⚠️ 【绝不可在此行之前加载任何 native 库】
    // loadReactNative 里才初始化 SoLoader 与 Fresco。若在它之前调用 native 库（例如 Conscrypt），
    // 会因 SoLoader 未就绪抛 Error；一旦冒泡出去，本行不执行 → Fresco 未初始化 →
    // 渲染第一个 <Image> 时 Fresco.newDraweeControllerBuilder() 为 null → 启动即崩
    // （2026-09-11 真机实测：java.lang.NullPointerException at ReactImageManager.createViewInstance）。
    loadReactNative(this)

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