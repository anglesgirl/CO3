package com.co3.ech
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
class EchNativePackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(EchNativeModule(ctx))
    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*,*>> = emptyList()
}
