package com.co3.ech

import android.util.Base64
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
import com.liar.han1meplus.EchHttpClient
import org.json.JSONObject

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
                  var f=document.getElementById('new_user');
                  if(!f || f._coHijacked) return;
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
            android.util.Log.i("CO-ECH", "postLogin "+url+" bodyLen="+body.length)
            try { com.co3.Diagnostics.event("webview_postLogin", mapOf("url" to url.take(80), "len" to body.length.toString())) } catch(_:Exception){}
            Thread {
                try {
                    val dohUrl = "https://82sew1c85i.cloudflare-gateway.com/dns-query"
                    val dohResolve = "82sew1c85i.cloudflare-gateway.com:443:162.159.36.20,162.159.36.5"
                    // 注入 Cookie
                    val cm = CookieManager.getInstance()
                    val cookie = try { cm.getCookie(url) ?: "" } catch(_:Exception){ "" }
                    val headers = mutableListOf<String>()
                    if (cookie.isNotEmpty()) headers.add("Cookie: "+cookie)
                    headers.add("Content-Type: application/x-www-form-urlencoded")
                    headers.add("Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                    headers.add("Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5")
                    // HAR 成功：Referer 带 ?return_to=%2F，Origin 必带
                    // 确保 POST URL 带 return_to，否则 AO3 可能返回 200 无跳转
                    val postUrl = if (url.contains("?")) url else if (url.contains("/users/login")) url + "?return_to=%2F" else url
                    headers.add("Referer: https://archiveofourown.org/users/login?return_to=%2F")
                    headers.add("Origin: https://archiveofourown.org")
                    headers.add("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                    headers.add("Upgrade-Insecure-Requests: 1")
                    headers.add("Sec-Fetch-Dest: document")
                    headers.add("Sec-Fetch-Mode: navigate")
                    headers.add("Sec-Fetch-Site: same-origin")
                    headers.add("Sec-Fetch-User: ?1")
                    headers.add("Priority: u=0, i")
                    val bodyBytes = body.toByteArray(Charsets.UTF_8)
                    // ECH POST，带 body
                    val jsonStr = EchHttpClient.request("POST", postUrl, headers.toTypedArray(), bodyBytes, dohUrl, dohResolve)
                    val json = JSONObject(jsonStr)
                    val statusCode = json.optInt("statusCode", 200)
                    val bodyBase64 = json.optString("body", "")
                    val headersJson = json.optJSONArray("headers")
                    var location: String? = null
                    var isSession = false
                    // 真正的登录成功标志：user_credentials cookie（匿名会话也有 _otwarchive_session，不能用作登录判定）
                    var hasUserCredentials = false
                    val htmlText = if (bodyBase64.isNotEmpty()) String(Base64.decode(bodyBase64, Base64.DEFAULT), Charsets.UTF_8) else ""
                    if (headersJson != null) {
                        for (i in 0 until headersJson.length()) {
                            val h = headersJson.optString(i) ?: continue
                            val idx = h.indexOf('\t')
                            if (idx <= 0) continue
                            val name = h.substring(0, idx)
                            val value = h.substring(idx+1)
                            if (name.equals("set-cookie", true)) {
                                var fixed = value
                                fixed = fixed.replace(Regex(";\\s*Domain=[^;]+", RegexOption.IGNORE_CASE), "")
                                fixed = fixed.replace(Regex(";\\s*Secure", RegexOption.IGNORE_CASE), "")
                                fixed = fixed.replace(Regex(";\\s*SameSite=[^;]+", RegexOption.IGNORE_CASE), "; SameSite=Lax")
                                try { cm.setCookie(url, fixed) } catch(_:Exception){}
                                try { cm.setCookie("https://archiveofourown.org/", fixed) } catch(_:Exception){}
                                if (value.contains("user_credentials")) hasUserCredentials = true
                                if (value.contains("_otwarchive_session")) isSession = true
                            }
                            if (name.equals("location", true) || name.equals("Location", true)) location = value
                        }
                        cm.flush()
                    }
                    // 诊断：POST 响应 HTML 片段（脱敏）用于定位 Session Expired 等
                    try { com.co3.Diagnostics.event("webview_postLogin_html", mapOf("status" to statusCode.toString(), "snippet" to htmlText.take(600).replace("\n"," ").take(600), "hasCred" to hasUserCredentials.toString())) } catch(_:Exception){}
                    // 登录成功判定：POST 后直接读 CookieManager 的 user_credentials（AO3 登录成功才下发）。
                    // 信任本地真实 cookie，不再解析 HTML/发额外验证请求。
                    val loginSuccess = hasUserCredentials
                    // 密码错误判定：200 且页面含错误提示（HAR 失败页是 "The password or username you entered doesn't match"）
                    val isWrongPassword = !loginSuccess && statusCode == 200 &&
                        (htmlText.contains("Wrong username or password", true) || htmlText.contains("doesn't match", true) || htmlText.contains("does not match", true) || htmlText.contains("Invalid", true))
                    try { com.co3.Diagnostics.event("webview_postLogin_result", mapOf("status" to statusCode.toString(), "hasSession" to isSession.toString(), "loginSuccess" to loginSuccess.toString(), "wrongPwd" to isWrongPassword.toString(), "location" to (location?: "").take(80))) } catch(_:Exception){}
                    android.util.Log.i("CO-ECH", "postLogin result status="+statusCode+" loginSuccess="+loginSuccess+" wrongPwd="+isWrongPassword+" location="+location)
                    val bodyBytesDecoded = if (bodyBase64.isNotEmpty()) Base64.decode(bodyBase64, Base64.DEFAULT) else ByteArray(0)
                    val html = String(bodyBytesDecoded, Charsets.UTF_8)
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
                                webView.loadDataWithBaseURL(url, html, "text/html", "utf-8", url)
                            } else {
                                webView.loadUrl(url)
                            }
                        } catch(e:Exception){ android.util.Log.e("CO-ECH", "load result err "+e.message) }
                    }
                } catch (e: Exception) {
                    android.util.Log.e("CO-ECH", "postLogin failed "+e.message)
                    try { com.co3.Diagnostics.event("webview_postLogin_fail", mapOf("err" to (e.message?:"unknown").take(120))) } catch(_:Exception){}
                    webView.post { try { webView.loadUrl(url) } catch(_:Exception){} }
                }
            }.start()
        }
    }

    @ReactProp(name = "sourceUrl")
    fun setSourceUrl(view: WebView, url: String?) {
        if (!url.isNullOrEmpty()) view.loadUrl(url)
    }
}
