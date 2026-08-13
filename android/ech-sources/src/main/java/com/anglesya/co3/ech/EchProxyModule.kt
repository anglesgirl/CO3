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
                val chosen = if (port != 0) port else freePort()
                Echproxy.start(
                    "127.0.0.1:$chosen",   // listen
                    "archiveofourown.org", // target
                    "",                     // echB64 (empty -> DoH / fallback + retry_configs)
                    doh,                    // DoH JSON endpoint (from JS; may be empty)
                    ipList,                 // preferred edge IPs (from JS; may be empty)
                    java.io.File(reactContext.filesDir, "ech-public-config.json").absolutePath,
                    false,                  // insecure
                )
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
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("ECH_STOP_FAILED", e.message, e)
            }
        }
    }

    /**
     * 只清除 AO3 会话 cookie(_otwarchive_session / user_credentials),
     * 保留 cf_clearance。登录重试时 AO3 不再 302 到用户主页,且不会
     * 作废用户刚完成的 Cloudflare 验证(重启代理会连 cf_clearance 一起丢)。
     */
    @ReactMethod
    fun clearSessionCookies(promise: Promise) {
        io.execute {
            try {
                Echproxy.clearSessionCookies()
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("ECH_CLEAR_SESSION_FAILED", e.message, e)
            }
        }
    }

    /**
     * 返回代理 cookie jar 的内容摘要(诊断用)。
     */
    @ReactMethod
    fun jarInfo(promise: Promise) {
        io.execute {
            try {
                promise.resolve(Echproxy.jarInfo())
            } catch (e: Throwable) {
                promise.reject("ECH_JARINFO_FAILED", e.message, e)
            }
        }
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
