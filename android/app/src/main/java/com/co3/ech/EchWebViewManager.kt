package com.co3.ech

import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.JavascriptInterface
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class EchWebViewManager : SimpleViewManager<WebView>() {
    private var reactContext: ThemedReactContext? = null
    override fun getName() = "EchWebView"

    /**
     * 登录 POST 经 EchEngineClient（Conscrypt ECH + OkHttp）：不跟随重定向，
     * 302 + Set-Cookie 原样回转发层处理。
     */
    companion object {
    }

    /** 页面是否属于 AO3 浏览。引擎不监听端口，页面就是原始 AO3 地址。 */
    private fun isLocalPage(url: String): Boolean = url.contains("archiveofourown.org")

    override fun createViewInstance(reactContext: ThemedReactContext): WebView {
        this.reactContext = reactContext
        val wv = WebView(reactContext)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.allowFileAccess = false
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)
        wv.addJavascriptInterface(Bridge(wv, reactContext), "CoBridge")
        wv.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val ech = CoWebViewHelper.intercept(request)
                if (ech != null) return ech
                return super.shouldInterceptRequest(view, request)
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // 劫持后的登录成功跳转由 Bridge 负责 loadUrl，这里不拦截
                return false
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // 注入「登录表单劫持」：只接管登录表单的提交，不做任何 URL 改写。
                // 页面内的 fetch/XHR 仍走 WebView 网络栈，由 shouldInterceptRequest
                // 交给引擎。
                if (url != null && isLocalPage(url)) injectLoginHijack(view)
            }
            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                if (url != null && isLocalPage(url)) {
                    // 页面脚本可能重建了表单，再注入一次（脚本内有幂等判断）。
                    injectLoginHijack(view)
                    // 登录成功检测：页面跳离登录页 且 CookieManager 里有 user_credentials（AO3 登录成功才下发）
                    // 这才是"WebView 登录成功 → App 取到登录信息"的正确路径
                    if (!url.contains("/users/login") && !url.contains("/login") &&
                        (url.contains("/users/") || url.contains("/works") || url.contains("/series") || url.contains("/collections"))) {
                        try {
                            val cm = CookieManager.getInstance()
                            val cookie = cm.getCookie("https://archiveofourown.org/") ?: ""
                            val hasCred = cookie.contains("user_credentials")
                            com.co3.Diagnostics.event("login_page_check", mapOf("url" to url.take(80), "hasCred" to hasCred.toString(), "cookieLen" to cookie.length.toString()))
                            if (hasCred) {
                                reactContext?.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                    ?.emit("LoginSuccess", com.facebook.react.bridge.Arguments.createMap())
                                com.co3.Diagnostics.event("login_success_emit", mapOf("url" to url.take(80)))
                            }
                        } catch (_: Exception) {}
                    }
                    // 页面文本回传：注册/激活/排队等账号流程页提交后，页面返回结果，
                    // App 外小窗体做翻译提示（RN 侧按 URL 过滤，浏览作品页不打扰）。
                    extractPageText(view, url)
                    // 引擎路线下 cookie 只有一份：原生 CookieManager。引擎零 cookie 代码，
                    // 页面加载完就直接按它判登录态，不需要再做 jar → CookieManager 同步。
                }
            }
        }
        return wv
    }

    /**
     * 提取页面正文文本回传给 JS 层（EchPageText 事件），供账号流程页
     * （注册/激活/申请排队）提交后的小窗体翻译提示使用。
     * 只取前 700 字符（结果提示都在页面开头）；RN 侧按 URL 过滤场景。
     */
    /**
     * 注入「登录表单劫持」：把登录表单的提交接管给原生 postLogin()。
     *
     * 为什么必须这么做：Android 的 shouldInterceptRequest **拿不到 POST body**，
     * 所以登录 POST 只能由原生侧代发；而只有原生侧代发才能走 ech_http 引擎完成
     * ECH。若交给 WebView 自己提交，那就是明文出网，必被阻断 —— 真机表现就是
     * 「登录按钮点下去没反应 / 一直转圈」。
     *
     * 这里**只劫持登录表单的提交**，不做任何 URL 改写。历史上有过一段注入会把
     * 页面内的 fetch / XHR / location 全改写成 http://127.0.0.1:<port>，而引擎
     * 不监听端口 —— 那等于把页面请求全部送去一个不存在的地址。
     */
    private fun injectLoginHijack(view: WebView) {
        view.evaluateJavascript(
            """
            (function(){
              if (window.__coLoginHijack) return;
              window.__coLoginHijack = 1;
              document.addEventListener('submit', function(e){
                var f = e.target;
                if (!f || !f.getAttribute) return;
                var action = f.getAttribute('action') || f.action || '';
                if (action.indexOf('/users/login') < 0) return;
                e.preventDefault();
                e.stopPropagation();
                var parts = [];
                var els = f.elements || [];
                for (var i = 0; i < els.length; i++) {
                  var el = els[i];
                  if (!el || !el.name || el.disabled) continue;
                  if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
                  parts.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value === undefined || el.value === null ? '' : el.value));
                }
                var body = parts.join('&');
                try {
                  CoBridge.onLoginHijacked('submit len=' + body.length);
                  CoBridge.postLogin(action, body);
                } catch (err) {}
              }, true);
            })();
            """.trimIndent(), null,
        )
    }

    private fun extractPageText(view: WebView, url: String?) {
        try {
            view.evaluateJavascript(
                "(function(){var b=document.body?document.body.innerText:'';" +
                    "return b.replace(/\\s+/g,' ').trim().substring(0,700);})()"
            ) { result ->
                val raw = result?.trim()
                if (!raw.isNullOrEmpty() && raw != "null" && raw.length > 2) {
                    // evaluateJavascript 返回 JSON 编码的字符串（外层带引号），
                    // 剥壳 + 还原转义即可得到页面文本。
                    val text = raw.substring(1, raw.length - 1)
                        .replace("\\\"", "\"")
                        .replace("\\n", " ")
                        .replace("\\t", " ")
                    if (text.isNotBlank()) {
                        // "已登录" 直接认 Cookie：/users/login 页显示 "You are already
                        // logged in" 说明 CookieManager 里的会话有效，直接发登录成功，
                        // 不用用户再填一遍表单（2026-10-02 用户反馈）。
                        if (text.contains("You are already logged in", true) &&
                            (url ?: "").contains("/users/login")
                        ) {
                            try {
                                val cm = android.webkit.CookieManager.getInstance()
                                val cookie = cm.getCookie("https://archiveofourown.org/") ?: ""
                                if (cookie.contains("user_credentials")) {
                                    reactContext?.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                        ?.emit("LoginSuccess", com.facebook.react.bridge.Arguments.createMap())
                                    com.co3.Diagnostics.event("login_already_logged_in", mapOf("url" to (url ?: "").take(80)))
                                }
                            } catch (_: Exception) {}
                        }
                        reactContext?.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            ?.emit(
                                "EchPageText",
                                com.facebook.react.bridge.Arguments.createMap().apply {
                                    putString("url", url ?: "")
                                    putString("text", text)
                                }
                            )
                    }
                }
            }
        } catch (_: Exception) {}
    }


    class Bridge(private val webView: WebView, private val reactContext: ThemedReactContext?) {
        /** 从本地地址还原回 AO3 https（postLogin 兜底入口兼容 127 URL）。 */
        // 引擎不监听端口，URL 里不会再有 127.0.0.1 前缀，历史遗留的本地地址
        // 仍做一次还原以兼容旧链接。
        private fun unrewrite(url: String): String {
            val m = Regex("^http://127\\.0\\.0\\.1:\\d+").find(url)
            return if (m != null) "https://archiveofourown.org" + url.substring(m.value.length) else url
        }

        @JavascriptInterface fun onLoginHijacked(msg: String) {
            android.util.Log.i("CO-ECH", "login hijack: "+msg.take(120))
            try { com.co3.Diagnostics.event("webview_login_hijack", mapOf("msg" to msg.take(120))) } catch(_:Exception){}
        }
        @JavascriptInterface fun postLogin(url: String, body: String) {
            // ① 入口立即把 url 规范化为绝对 AO3 URL（JS 传来的 f.action 可能是相对路径 "/users/login"，
            //    也可能是本地转发地址 http://127.0.0.1:8080/users/login —— 一并还原）
            val absoluteUrl = unrewrite(if (url.startsWith("http")) url else "https://archiveofourown.org" + url)
            android.util.Log.i("CO-ECH", "postLogin "+absoluteUrl+" bodyLen="+body.length)
            try { com.co3.Diagnostics.event("webview_postLogin", mapOf("url" to absoluteUrl.take(80), "len" to body.length.toString(), "hasToken" to body.contains("authenticity_token").toString(), "hasLogin" to body.contains("user%5Blogin%5D").toString())) } catch(_:Exception){}
            Thread {
                try {
                    // 【改造】POST 走本地 Go ECH 代理（回迁 Go 后不再直连 Conscrypt）。
                    // Go 转发层 302 天然透传（CheckRedirect=ErrUseLastResponse）——
                    // 302 里的 Set-Cookie（user_credentials）不会被中间层吃掉。
                    val cm = CookieManager.getInstance()
                    // 确保 POST URL 带 return_to，否则 AO3 可能返回 200 无跳转
                    val postUrl = if (absoluteUrl.contains("?")) absoluteUrl
                                  else if (absoluteUrl.contains("/users/login")) absoluteUrl + "?return_to=%2F"
                                  else absoluteUrl
                    // 用 ech_http 引擎发这个 POST，不再走任何本地端口。
                    // 引擎不跟随重定向（CURLOPT_FOLLOWLOCATION=0），所以 302 本身
                    // 和它携带的 Set-Cookie（user_credentials）都会原样回来 ——
                    // 那正是登录成功的唯一判据。若跟随了就只能看到最终 200，
                    // 读不到 user_credentials（旧实现正是这么栽的）。
                    val hb = listOf(
                        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
                        // HAR 成功样本：Referer 必带 ?return_to=%2F，Origin 必带
                        "Referer: https://archiveofourown.org/users/login?return_to=%2F",
                        "Origin: https://archiveofourown.org",
                        "User-Agent: ${CoWebViewHelper.AO3_UA}",
                        "Content-Type: application/x-www-form-urlencoded",
                        "Upgrade-Insecure-Requests: 1",
                        "Sec-Fetch-Dest: document",
                        "Sec-Fetch-Mode: navigate",
                        "Sec-Fetch-Site: same-origin",
                        "Sec-Fetch-User: ?1",
                        "Priority: u=0, i",
                    ).joinToString("\r\n")

                    var statusCode = 0
                    var location: String? = null
                    var isSession = false
                    // 真正的登录成功标志：user_credentials cookie（匿名会话也有 _otwarchive_session，不能用作登录判定）
                    var hasUserCredentials = false
                    var htmlText = ""

                    val resp = EchEngineClient.request(
                        host = "archiveofourown.org",
                        url = postUrl,
                        method = "POST",
                        headers = hb,
                        body = body.toByteArray(Charsets.UTF_8),
                        totalTimeoutMs = 45_000L,
                    )
                    statusCode = resp.status
                    htmlText = String(resp.body, Charsets.UTF_8)
                    resp.headers.split("\r\n", "\n").forEach { line ->
                        val idx = line.indexOf(':')
                        if (idx <= 0) return@forEach
                        val name = line.substring(0, idx).trim()
                        val value = line.substring(idx + 1).trim()
                        when {
                            name.equals("Location", true) -> location = value
                            name.equals("Set-Cookie", true) -> {
                                // 兼容旧行为：去 Domain/Secure 后再写 CookieManager，
                                // 确保 WebView 也能收下（尤其 user_credentials）
                                var fixed = value
                                fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                                fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                                fixed = fixed.replace(Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE), "; SameSite=Lax")
                                try { cm.setCookie(absoluteUrl, fixed) } catch (_: Exception) {}
                                try { cm.setCookie("https://archiveofourown.org/", fixed) } catch (_: Exception) {}
                                if (value.contains("user_credentials")) hasUserCredentials = true
                                if (value.contains("_otwarchive_session")) isSession = true
                            }
                        }
                    }
                    cm.flush()
                    // 双保险：即使这一跳的响应头没读到，也从 CookieManager 复核登录态
                    if (!hasUserCredentials) {
                        hasUserCredentials = try {
                            (cm.getCookie("https://archiveofourown.org/") ?: "").contains("user_credentials")
                        } catch (_: Exception) {
                            false
                        }
                    }
                    // 诊断：POST 响应 HTML 片段（脱敏）用于定位 Session Expired 等
                    // 取 body 中的错误提示而非 head
                    val snippet = try {
                        val errIdx = htmlText.indexOf("class=\"error\"")
                        val msgIdx = htmlText.indexOf("doesn't match")
                        val idx = when {
                            errIdx >= 0 -> maxOf(0, errIdx - 100)
                            msgIdx >= 0 -> maxOf(0, msgIdx - 100)
                            htmlText.contains("Session expired") -> maxOf(0, htmlText.indexOf("Session expired") - 100)
                            else -> 0
                        }
                        htmlText.substring(idx, minOf(htmlText.length, idx + 600)).replace("\n"," ").take(600)
                    } catch(_:Exception){ htmlText.take(600).replace("\n"," ").take(600) }
                    try { com.co3.Diagnostics.event("webview_postLogin_html", mapOf("status" to statusCode.toString(), "snippet" to snippet, "hasCred" to hasUserCredentials.toString(), "hasSessionHeader" to isSession.toString())) } catch(_:Exception){}
                    // 登录成功判定：POST 后直接读 CookieManager 的 user_credentials（AO3 登录成功才下发）。
                    // 信任本地真实 cookie，不再解析 HTML/发额外验证请求。
                    val loginSuccess = hasUserCredentials
                    // 密码错误判定：200 且页面含错误提示（HAR 失败页是 "The password or username you entered doesn't match"）
                    val isWrongPassword = !loginSuccess && statusCode == 200 &&
                        (htmlText.contains("Wrong username or password", true) || htmlText.contains("doesn't match", true) || htmlText.contains("does not match", true) || htmlText.contains("Invalid", true))
                    try { com.co3.Diagnostics.event("webview_postLogin_result", mapOf("status" to statusCode.toString(), "hasSession" to isSession.toString(), "loginSuccess" to loginSuccess.toString(), "wrongPwd" to isWrongPassword.toString(), "location" to (location?: "").take(80))) } catch(_:Exception){}
                    android.util.Log.i("CO-ECH", "postLogin result status="+statusCode+" loginSuccess="+loginSuccess+" wrongPwd="+isWrongPassword+" location="+location)
                    val html = htmlText
                    webView.post {
                        try {
                            if (isWrongPassword) {
                                // 密码错误：明确提示，不要渲染成"看起来成功"
                                webView.evaluateJavascript("alert('用户名或密码错误，请重试');", null)
                                webView.loadUrl("https://archiveofourown.org/users/login")
                            } else if (loginSuccess) {
                                // 登录成功：回传 RN 刷新登录状态（全局事件，兼容 RN 0.85）
                                try {
                                    reactContext?.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                        ?.emit("LoginSuccess", com.facebook.react.bridge.Arguments.createMap())
                                } catch (_: Exception) {}
                                try { com.co3.Diagnostics.event("login_success_notify", mapOf("status" to statusCode.toString())) } catch(_:Exception){}
                                // 关键：不能 loadDataWithBaseURL 渲染静态 HTML（JS 不执行、cookie 不同步，右上角不更新）。
                                // 重新 loadUrl 真实 https 页面 → WebView 子请求由引擎接管，CookieManager 的会话随之生效
                                val target = if (location != null && (location!!.startsWith("http"))) location!!
                                    else if (location != null) "https://archiveofourown.org" + location!!
                                    else "https://archiveofourown.org/"
                                webView.loadUrl(target)
                            } else if (statusCode in 300..399 && location != null) {
                                val target = if (location!!.startsWith("http")) location!! else "https://archiveofourown.org" + location!!
                                webView.loadUrl(target)
                            } else if (html.isNotEmpty()) {
                                webView.loadDataWithBaseURL(absoluteUrl, html, "text/html", "utf-8", absoluteUrl)
                            } else {
                                webView.loadUrl(absoluteUrl)
                            }
                        } catch(e:Exception){ android.util.Log.e("CO-ECH", "load result err "+e.message) }
                    }
                } catch (e: Exception) {
                    android.util.Log.e("CO-ECH", "postLogin failed "+e.message)
                    try { com.co3.Diagnostics.event("webview_postLogin_fail", mapOf("err" to (e.message?:"unknown").take(120))) } catch(_:Exception){}
                    webView.post { try { webView.loadUrl(absoluteUrl) } catch(_:Exception){} }
                }
            }.start()
        }
    }

    @ReactProp(name = "sourceUrl")
    fun setSourceUrl(view: WebView, url: String?) {
        // 引擎路线：原始 https URL 直接交给 WebView，子请求由
        // CoWebViewHelper.intercept 逐个交给 ech_http 引擎。
        if (!url.isNullOrEmpty()) {
            // ech_http 引擎不监听端口，所以这里**不再做 URL 改写**：直接把原始
            // https URL 交给 WebView，子请求由 CoWebViewHelper.intercept 逐个交给
            // 引擎（ECH 在同一进程内完成）。若仍改写，拦截路径收到的会是 127.0.0.1
            // 而被当成本地转发直接放行 —— 等于绕过引擎、退回明文风险。
            android.util.Log.i("CO-ECH", "load $url (via ech_http engine)")
            view.loadUrl(url)
        }
    }
}
