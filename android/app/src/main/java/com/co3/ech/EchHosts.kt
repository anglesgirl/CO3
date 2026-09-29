package com.co3.ech

/**
 * 哪些域名必须走 ECH（与旧 Conscrypt 实现里的判定保持一致）。
 * 回迁 Go 后仍用于 CoWebViewHelper 的 fail-closed 判定：
 * 受保护域（AO3）失败一律 502，非保护域如实放回 WebView 处理。
 */
object EchHosts {
    fun isProtected(host: String): Boolean {
        val h = host.lowercase()
        return h == "archiveofourown.org" || h.endsWith(".archiveofourown.org")
    }
}
