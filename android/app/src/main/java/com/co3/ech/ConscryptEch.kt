package com.co3.ech

import android.util.Log
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.Response
import org.conscrypt.Conscrypt
import org.conscrypt.DomainEncryptionMode
import org.conscrypt.NetworkSecurityPolicy
import org.conscrypt.metrics.CertificateTransparencyVerificationReason
import java.io.IOException
import java.net.InetAddress
import java.net.Socket
import java.net.UnknownHostException
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** 哪些域名必须走 ECH（与旧拦截器里的判定保持一致） */
object EchHosts {
    fun isProtected(host: String): Boolean {
        val h = host.lowercase()
        return h == "archiveofourown.org" || h.endsWith(".archiveofourown.org")
    }
}

/**
 * Conscrypt（BoringSSL 内核）承担的 ECH 传输层。
 *
 * 为什么这条路干净：它是标准 JSSE provider —— OkHttp 的重定向、Cookie、gzip、连接池
 * 全部走原生语义，不再需要 JNI 桥 / libcurl / 手写重定向处理。
 *
 * 【最容易踩的坑，必须保留注释】Conscrypt 用**反射**从 X509TrustManager 上取
 * `getNetworkSecurityPolicy()`；取不到就回落平台默认策略（Android API 36 = DISABLED），
 * 而 DISABLED 会让 `getEchOptions()` 返回 null、`enableEchBasedOnPolicy()` 首行就 return
 * —— 结果是 setEchConfigList 完全白设，ECH 扩展一个字节都不发（且完全静默）。
 * 所以 PolicyTrustManager 上那个方法就是整套 ECH 的开关，绝不能删。
 */
object ConscryptEch {

    private const val TAG = "CO-ECH"

    @Volatile
    var ready = false
        private set

    private val provider = Conscrypt.newProvider()

    private val systemTrustManager: X509TrustManager by lazy {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as KeyStore?)
        tmf.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
            ?: throw IllegalStateException("系统 X509TrustManager 不可用")
    }

    /** 给 OkHttp 用的信任管理器（证书校验委托给系统，另挂 ECH 策略） */
    val trustManager: X509TrustManager by lazy { PolicyTrustManager(systemTrustManager) }

    private val sslContext: SSLContext by lazy {
        SSLContext.getInstance("TLSv1.3", provider).apply {
            // 必须把 PolicyTrustManager 传进 SSLContext，Conscrypt 才反射得到策略
            init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
        }
    }

    val socketFactory: SSLSocketFactory by lazy { EchSocketFactory(sslContext.socketFactory) }

    fun install() {
        if (ready) return
        ready = true
        Log.i(TAG, "Conscrypt ECH 就绪，version=${runCatching { Conscrypt.version().toString() }.getOrNull()}")
    }

    class PolicyTrustManager(private val delegate: X509TrustManager) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            delegate.checkClientTrusted(chain, authType)
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            delegate.checkServerTrusted(chain, authType)
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = delegate.acceptedIssuers

        /** Conscrypt 反射找的就是这个方法 —— 整套 ECH 的开关 */
        @Suppress("unused")
        fun getNetworkSecurityPolicy(): NetworkSecurityPolicy = POLICY
    }

    private val POLICY = object : NetworkSecurityPolicy {
        override fun isCertificateTransparencyVerificationRequired(hostname: String?): Boolean = false

        override fun getCertificateTransparencyVerificationReason(hostname: String?):
            CertificateTransparencyVerificationReason = CertificateTransparencyVerificationReason.UNKNOWN

        override fun getDomainEncryptionMode(hostname: String?): DomainEncryptionMode =
            if (hostname != null && EchHosts.isProtected(hostname)) DomainEncryptionMode.ENABLED
            else DomainEncryptionMode.DISABLED
    }

    /**
     * 包装 Conscrypt 的 SSLSocketFactory：在返回 socket 前按 host 注入 ECHConfigList。
     * OkHttp 走的是 createSocket(Socket, String, int, boolean) 这个重载。
     * 拿不到配置时**抛异常**（fail-closed）—— 宁可不连，也绝不明文暴露被墙域名的 SNI。
     */
    private class EchSocketFactory(private val delegate: SSLSocketFactory) : SSLSocketFactory() {

        override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites

        override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites

        private fun prepare(s: Socket, host: String?): Socket {
            if (host == null || s !is SSLSocket || !EchHosts.isProtected(host)) return s
            val cfg = EchDoh.echConfigList(host)
                ?: throw IOException("ECH 配置不可用（fail-closed）：拒绝以明文访问 $host")
            try {
                Conscrypt.setEchConfigList(s, cfg)
            } catch (t: Throwable) {
                throw IOException("setEchConfigList 失败（fail-closed）: ${t.message}")
            }
            return s
        }

        override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket =
            prepare(delegate.createSocket(s, host, port, autoClose), host)

        override fun createSocket(host: String, port: Int): Socket =
            prepare(delegate.createSocket(host, port), host)

        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
            prepare(delegate.createSocket(host, port, localHost, localPort), host)

        // 只给到 IP、拿不到域名的那两个重载无法注入 ECH；保护域名不会走到这里（有 Dns 与 host 重载）
        override fun createSocket(host: InetAddress, port: Int): Socket = delegate.createSocket(host, port)

        override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
            delegate.createSocket(address, port, localAddress, localPort)
    }
}

/**
 * 保护域名用 DoH 解析（系统 DNS 在大陆被污染，连到假 IP 会得出错误结论）。
 * 解析失败即抛异常：fail-closed，不回落系统 DNS。
 */
class EchDns(private val system: Dns = Dns.SYSTEM) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        if (!EchHosts.isProtected(hostname)) return system.lookup(hostname)
        val addrs = EchDoh.resolve(hostname)
        if (addrs.isEmpty()) throw UnknownHostException("DoH 解析失败（fail-closed）：$hostname")
        return addrs
    }
}

/**
 * ECH 被服务器拒绝（密钥轮换/配置过期）时清掉缓存，让 OkHttp 的重试拿到新配置。
 * Conscrypt 会抛 EchRejectedException 并附带 retryConfigs，这里只做失效 + 重试，不改语义。
 */
class EchRetryInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val host = chain.request().url.host
        return try {
            chain.proceed(chain.request())
        } catch (t: Throwable) {
            val echRejected = generateSequence(t) { it.cause }
                .any { it.javaClass.simpleName.contains("EchRejected", ignoreCase = true) }
            if (echRejected && EchHosts.isProtected(host)) {
                Log.w("CO-ECH", "ECH 被拒，清缓存以便用 retryConfigs 重试: $host")
                EchDoh.invalidateEch(host)
            }
            throw t
        }
    }
}
