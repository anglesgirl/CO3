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
    try {
        com.liar.han1meplus.EchHttpClient.init(this)
        android.util.Log.i("CO-ECH", "EchHttpClient init ok, isLoaded=" + com.liar.han1meplus.EchHttpClient.isLoaded)
        // Hook React Native OkHttp
        try {
            val provider = Class.forName("com.facebook.react.modules.network.OkHttpClientProvider")
            val method = provider.getMethod("setOkHttpClientFactory", Class.forName("com.facebook.react.modules.network.OkHttpClientFactory"))
            val factory = com.co3.ech.ReactNativeEchFactory()
            method.invoke(null, factory)
            android.util.Log.i("CO-ECH", "OkHttpClientProvider patched")
        } catch (e: Exception) {
            android.util.Log.w("CO-ECH", "OkHttp hook failed (will use NativeModule only): " + e.message)
        }
    } catch (e: Exception) {
        android.util.Log.e("CO-ECH", "ECH init failed: " + e.message)
    }
    com.co3.Diagnostics.initialize()
    ProcessLifecycleOwner.get().lifecycle.addObserver(AppForegroundTracker)
    loadReactNative(this)
  }
}