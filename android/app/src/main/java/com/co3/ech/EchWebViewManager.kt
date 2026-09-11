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
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class EchWebViewManager : SimpleViewManager<WebView>() {
    private var reactContext: ThemedReactContext? = null
    override fun getName() = "EchWebView"

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
            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                if (url != null && url.contains("archiveofourown.org")) {
                    injectLoginHijack(view)
                    // 登录成功检测：页面跳离登录页 且 CookieManager 里有 user_credentials（AO3 登录成功才下发）
                    // 这才是"WebView 登录成功 → App 取到登录信息"的正确路径，不依赖 postLogin 劫持判定
                    if (!url.contains("/users/login") && !url.contains("/login") &&
                        (url.contains("/users/") || url.contains("/works") || url.contains("/series") || url.contains("/collections") || url.endsWith("archiveofourown.org/") || url.endsWith("archiveofourown.org"))) {
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
                }
            }
        }
        return wv
    }

    private fun injectLoginHijack(view: WebView) {
        try {
            view.evaluateJavascript("""
                (function(){
                  // 先扫描已存在的表单，再监听动态插入，避免页面已完成加载时漏绑 submit。
                  function scan(){
                    var f=document.getElementById('new_user');
                    if(f && !f._coHijacked){
                      f._coHijacked=true;
                      try{ window.CoBridge.onLoginHijacked('found new_user'); }catch(e){}
                      f.addEventListener('submit', function(e){
                        e.preventDefault();
                        e.stopPropagation();
                        try{
                          var fd=new FormData(f);
                          var params=new URLSearchParams();
                          for(var pair of fd.entries()){ params.append(pair[0], pair[1]); }
                          var body=params.toString();
                          window.CoBridge.postLogin(f.action || window.location.href, body);
                        }catch(err){
                          try{ window.CoBridge.onLoginHijacked('hijack err:'+err); }catch(e){}
                          f.submit();
                        }
                      }, true);
                    }
                  }
                  scan();
                  new MutationObserver(scan).observe(document, {childList: true, subtree: true});
                })();
            """.trimIndent(), null)
        } catch(_:Exception){}
    }

    class Bridge(private val webView: WebView, private val reactContext: ThemedReactContext?) {
        @JavascriptInterface fun onLoginHijacked(msg: String) {
            android.util.Log.i("CO-ECH", "login hijack: "+msg.take(120))
            try { com.co3.Diagnostics.event("webview_login_hijack", mapOf("msg" to msg.take(120))) } catch(_:Exception){}
        }
        @JavascriptInterface fun postLogin(url: String, body: String) {
            // ① 入口立即把 url 规范化为绝对 URL（JS 传来的 f.action 可能是相对路径 "/users/login"）
            val absoluteUrl = if (url.startsWith("http")) url else "https://archiveofourown.org" + url
            android.util.Log.i("CO-ECH", "postLogin "+absoluteUrl+" bodyLen="+body.length)
            try { com.co3.Diagnostics.event("webview_postLogin", mapOf("url" to absoluteUrl.take(80), "len" to body.length.toString(), "hasToken" to body.contains("authenticity_token").toString(), "hasLogin" to body.contains("user%5Blogin%5D").toString())) } catch(_:Exception){}
            Thread {
                try {
                    // 【改造】POST 改走 OkHttp + Conscrypt（标准语义），不再走 JNI + libcurl。
                    // 关键收益：302 响应里的 Set-Cookie（user_credentials）不会再被中间层吃掉 —— 那正是登录失败的老根因。
                    // Cookie 交给 cookieJar（同一 CookieManager）注入，不再手工拼 Cookie 头。
                    val cm = CookieManager.getInstance()
                    // 确保 POST URL 带 return_to，否则 AO3 可能返回 200 无跳转
                    val postUrl = if (absoluteUrl.contains("?")) absoluteUrl
                                  else if (absoluteUrl.contains("/users/login")) absoluteUrl + "?return_to=%2F"
                                  else absoluteUrl
                    // 登录 POST 用「不跟随重定向」的客户端：这样能直接读 302 与它携带的 Set-Cookie。
                    // 若跟随了就只能看到最终 200，读不到 user_credentials（旧 JNI 库正是这么栽的）。
                    val loginClient = EchHttp.client.newBuilder().followRedirects(false).build()
                    val reqBuilder = Request.Builder()
                        .url(postUrl)
                        .post(body.toRequestBody("application/x-www-form-urlencoded".toMediaType()))
                        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                        // HAR 成功样本：Referer 必带 ?return_to=%2F，Origin 必带
                        .header("Referer", "https://archiveofourown.org/users/login?return_to=%2F")
                        .header("Origin", "https://archiveofourown.org")
                        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
                        .header("Upgrade-Insecure-Requests", "1")
                        .header("Sec-Fetch-Dest", "document")
                        .header("Sec-Fetch-Mode", "navigate")
                        .header("Sec-Fetch-Site", "same-origin")
                        .header("Sec-Fetch-User", "?1")
                        .header("Priority", "u=0, i")
                    var statusCode = 200
                    var location: String? = null
                    var isSession = false
                    // 真正的登录成功标志：user_credentials cookie（匿名会话也有 _otwarchive_session，不能用作登录判定）
                    var hasUserCredentials = false
                    var htmlText = ""
                    loginClient.newCall(reqBuilder.build()).execute().use { resp ->
                        statusCode = resp.code
                        location = resp.header("Location")
                        htmlText = resp.body?.string() ?: ""
                        for (raw in resp.headers.values("Set-Cookie")) {
                            // 兼容旧行为：去 Domain/Secure 后再写 CookieManager，确保 WebView 也能收下（尤其 user_credentials）
                            var fixed = raw
                            fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                            fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                            fixed = fixed.replace(Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE), "; SameSite=Lax")
                            try { cm.setCookie(absoluteUrl, fixed) } catch (_: Exception) {}
                            try { cm.setCookie("https://archiveofourown.org/", fixed) } catch (_: Exception) {}
                            if (raw.contains("user_credentials")) hasUserCredentials = true
                            if (raw.contains("_otwarchive_session")) isSession = true
                        }
                        cm.flush()
                    }
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
                                // 重新 loadUrl 真实页面 → 走 ECH 拦截 + CookieManager 注入 cookie → 页面正常显示登录态
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
        if (!url.isNullOrEmpty()) view.loadUrl(url)
    }
}
