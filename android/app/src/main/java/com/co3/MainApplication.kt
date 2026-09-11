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
  }
}