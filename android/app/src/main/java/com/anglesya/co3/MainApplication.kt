package com.anglesya.co3

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
import com.anglesya.co3.export.FileExportPackage
import com.swmansion.rnscreens.RNScreensPackage;

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
                add(LibrarySchedulerPackage())
                // ECH native module: only present when the gomobile-built
                // echproxy.aar was copied into android/app/libs before the
                // build started (see build.gradle sourceSets exclude rule).
                // Load it by reflection so the non-ECH APK still compiles and
                // boots without the missing class. The JS side already handles
                // NativeModules.EchProxy being absent gracefully.
                try {
                    @Suppress("UNCHECKED_CAST")
                    val pkg = Class.forName("com.anglesya.co3.ech.EchProxyPackage")
                        .getDeclaredConstructor()
                        .newInstance() as ReactPackage
                    add(pkg)
                } catch (_: Throwable) { }
                add(FileExportPackage())
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
    ProcessLifecycleOwner.get().lifecycle.addObserver(AppForegroundTracker)
    loadReactNative(this)
  }
}
