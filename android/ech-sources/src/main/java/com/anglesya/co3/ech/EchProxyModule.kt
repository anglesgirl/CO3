package com.anglesya.co3.ech

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import echproxy.Echproxy
import java.util.concurrent.Executors

/**
 * Bridges the gomobile-built ECH proxy (package `echproxy`, class `Echproxy`)
 * to JavaScript. The proxy listens on 127.0.0.1:<port> and forwards every
 * request to https://archiveofourown.org over an ECH TLS handshake.
 *
 * JS usage:
 *   import { NativeModules } from 'react-native';
 *   const port = await NativeModules.EchProxy.start(0);   // 0 = auto-pick
 *   // point ky at http://127.0.0.1:<port>
 */
class EchProxyModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val io = Executors.newSingleThreadExecutor()

    companion object {
        /** 已启动的端口（进程级，跨 JS 重载存活）。0 = 未启动。 */
        @Volatile
        private var runningPort: Int = 0
    }

    override fun getName() = "EchProxy"

    /**
     * Starts the proxy. If [port] is 0 a free port is chosen automatically.
     * [doh] is the DoH JSON endpoint used to fetch AO3's ech= record (may be
     * empty to skip DoH and rely on the baked-in config + retry_configs).
     * [ipList] is an optional comma-separated list of preferred edge IPs; it
     * only changes the route, never the SNI/ECH encryption.
     * Resolves with the actual port number.
     */
    @ReactMethod
    fun start(port: Int, doh: String, ipList: String, promise: Promise) {
        io.execute {
            try {
                // 代理已在运行（JS 重载 / 启动竞态后常见）：直接复用已知端口。
                // Echproxy.start() 在已运行时抛 "echproxy already running"，
                // 而 JS 侧丢了端口号会不断重试 → 永远拿不到 base，全部请求
                // fail-closed（2026-08-11 iOS 真机日志实测到同一问题，
                // Android 同样代码路径，一并加固）。
                val known = runningPort
                if (known != 0 && isListening(known)) {
                    promise.resolve(known)
                    return@execute
                }

                val chosen = if (port != 0) port else freePort()
                val cachePath =
                    java.io.File(reactContext.filesDir, "ech-public-config.json").absolutePath
                try {
                    Echproxy.start(
                        "127.0.0.1:$chosen",   // listen
                        "archiveofourown.org", // target
                        "",                     // echB64 (empty -> DoH / fallback + retry_configs)
                        doh,                    // DoH JSON endpoint (from JS; may be empty)
                        ipList,                 // preferred edge IPs (from JS; may be empty)
                        cachePath,
                        false,                  // insecure
                    )
                } catch (e: Throwable) {
                    // 已在运行但端口未知 → 停掉再启，比让整个 App 断网好。
                    if (e.message?.contains("already running", ignoreCase = true) != true) throw e
                    runCatching { Echproxy.stop() }
                    Echproxy.start(
                        "127.0.0.1:$chosen", "archiveofourown.org", "",
                        doh, ipList, cachePath, false,
                    )
                }
                runningPort = chosen
                promise.resolve(chosen)
            } catch (e: Throwable) {
                promise.reject("ECH_START_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        io.execute {
            try {
                Echproxy.stop()
                runningPort = 0   // 端口已失效，别再复用
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("ECH_STOP_FAILED", e.message, e)
            }
        }
    }

    /** 端口上是否真的有人在听（记住的端口在进程被回收后可能已失效）。 */
    private fun isListening(port: Int): Boolean = try {
        java.net.Socket().use { socket ->
            socket.connect(java.net.InetSocketAddress("127.0.0.1", port), 300)
            true
        }
    } catch (_: Throwable) {
        false
    }

    /**
     * Looks up the TXT records of [name] over [doh] and resolves with their
     * contents (one record per line). Used to pull remote DoH/IP settings.
     */
    @ReactMethod
    fun fetchTxt(doh: String, name: String, promise: Promise) {
        io.execute {
            try {
                promise.resolve(Echproxy.fetchTxt(doh, name))
            } catch (e: Throwable) {
                promise.reject("ECH_TXT_FAILED", e.message, e)
            }
        }
    }

    /** Returns the latest proxy status line (handshake result / errors). */
    @ReactMethod
    fun status(promise: Promise) {
        try {
            promise.resolve(Echproxy.lastStatus())
        } catch (e: Throwable) {
            promise.reject("ECH_STATUS_FAILED", e.message, e)
        }
    }

    private fun freePort(): Int {
        java.net.ServerSocket(0).use { return it.localPort }
    }
}
