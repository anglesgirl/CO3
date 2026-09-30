package com.co3.ech

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * RN 桥：`NativeModules.EchProxy`（Android 版）。
 *
 * 镜像 iOS 的 EchProxyModule.swift，让同一份 JS 代码（echKy.js）双端共用：
 *   start(port, doh, ipList) -> Promise<port>
 *   stop / status / drainLogs / jarInfo / clearSessionCookies / fetchTxt
 *
 * 底层是 Go 代理（EchProxyCore，同进程 gomobile aar）——安卓回迁 Go 后，
 * echKy.js 在安卓上恢复可用（此前 EchWebViewPackage.createNativeModules
 * 是空列表，EchProxy 未注册，JS 侧一律 fail-closed）。
 */
class EchProxyModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule() {

    override fun getName() = "EchProxy"

    private val ioQueue: ExecutorService = Executors.newSingleThreadExecutor()

    @ReactMethod
    fun start(port: Int, doh: String, ipList: String, promise: Promise) {
        ioQueue.execute {
            try {
                // 落盘，供 App 下次冷启动直接复用（见 EchProxyCore.saveConfigPrefs 注释）
                EchProxyCore.saveConfigPrefs(ctx, doh, ipList)
                val p = EchProxyCore.ensureStarted(port, doh, ipList)
                if (p > 0) promise.resolve(p) else promise.reject("ECH_START_FAILED", "proxy failed to start")
            } catch (e: Exception) {
                promise.reject("ECH_START_FAILED", e.message ?: "unknown", e)
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        ioQueue.execute {
            try {
                EchProxyCore.stop()
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("ECH_STOP_FAILED", e.message ?: "unknown", e)
            }
        }
    }

    @ReactMethod
    fun clearSessionCookies(promise: Promise) {
        ioQueue.execute {
            try {
                EchProxyCore.clearSessionCookies()
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("ECH_CLEAR_FAILED", e.message ?: "unknown", e)
            }
        }
    }

    @ReactMethod
    fun jarInfo(promise: Promise) {
        ioQueue.execute { promise.resolve(EchProxyCore.jarInfo()) }
    }

    @ReactMethod
    fun fetchTxt(doh: String, name: String, promise: Promise) {
        ioQueue.execute {
            try {
                promise.resolve(EchProxyCore.fetchTxt(doh, name))
            } catch (e: Exception) {
                promise.reject("ECH_TXT_FAILED", e.message ?: "unknown", e)
            }
        }
    }

    @ReactMethod
    fun status(promise: Promise) {
        promise.resolve(EchProxyCore.lastStatus())
    }

    @ReactMethod
    fun drainLogs(promise: Promise) {
        promise.resolve(EchProxyCore.drainLogs())
    }
}
