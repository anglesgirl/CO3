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
                    // 兜底：页面跳离登录页 = 登录成功（覆盖 JS 劫持未生效/原生提交路径）
                    // AO3 登录成功后跳 /users/<用户名> 等；无 /users/dashboard 路径
                    if (!url.contains("/users/login") && !url.contains("/login") &&
                        (url.contains("/users/") || url.contains("/works") || url.contains("/series") || url.contains("/collections"))) {
                        try {
                            reactContext?.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                ?.emit("LoginSuccess", com.facebook.react.bridge.Arguments.createMap())
                            com.co3.Diagnostics.event("login_success_page_detect", mapOf("url" to url.take(80)))
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
                    headers.add("Referer: https://archiveofourown.org/users/login")
                    headers.add("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                    headers.add("Accept-Language: en-US,en;q=0.5")
                    val bodyBytes = body.toByteArray(Charsets.UTF_8)
                    // ECH POST，带 body
                    val jsonStr = EchHttpClient.request("POST", url, headers.toTypedArray(), bodyBytes, dohUrl, dohResolve)
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
                                try { cm.setCookie(url, value) } catch(_:Exception){}
                                if (value.contains("user_credentials")) hasUserCredentials = true
                                if (value.contains("_otwarchive_session")) isSession = true
                            }
                            if (name.equals("location", true) || name.equals("Location", true)) location = value
                        }
                        cm.flush()
                    }
                    // 登录成功判定：POST 响应不可靠（EchHttpClient 不跟随重定向，拿不到最终 URL）。
                    // 最稳：POST 后再 GET /users/dashboard 验证——dashboard 页无登录表单 = 真登录成功。
                    var loginSuccess = hasUserCredentials || (statusCode in 300..399 && location != null)
                    // 兜底：200 时主动验证（AO3 无 /users/dashboard 路径！用首页判定：登录后含 Log Out）
                    if (!loginSuccess && isSession) {
                        try {
                            val dashHeaders = mutableListOf<String>()
                            val cmCookie = cm.getCookie("https://archiveofourown.org/") ?: ""
                            if (cmCookie.isNotEmpty()) dashHeaders.add("Cookie: " + cmCookie)
                            dashHeaders.add("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                            val dashJsonStr = EchHttpClient.request(
                                "GET", "https://archiveofourown.org/",
                                dashHeaders.toTypedArray(), null, dohUrl, dohResolve
                            )
                            val dashJson = JSONObject(dashJsonStr)
                            val dashBody = dashJson.optString("body", "")
                            val dashHtml = if (dashBody.isNotEmpty()) String(Base64.decode(dashBody, Base64.DEFAULT), Charsets.UTF_8) else ""
                            val isLoginPage = dashHtml.contains("user[password]", true) || dashHtml.contains("user_password", true)
                            val hasLogout = dashHtml.contains("Log Out", true) || dashHtml.contains("log_out", true) || dashHtml.contains("logout", true)
                            loginSuccess = !isLoginPage && hasLogout && dashJson.optInt("statusCode", 0) == 200
                            com.co3.Diagnostics.event("postLogin_home_verify", mapOf("status" to dashJson.optInt("statusCode", 0).toString(), "loginSuccess" to loginSuccess.toString(), "hasLogout" to hasLogout.toString(), "len" to dashHtml.length.toString()))
                        } catch (e: Exception) {
                            com.co3.Diagnostics.event("postLogin_home_verify_fail", mapOf("err" to (e.message ?: "unknown")))
                        }
                    }
                    // 密码错误判定：200 且页面含错误提示
                    val isWrongPassword = !loginSuccess && statusCode == 200 &&
                        (htmlText.contains("Wrong username or password", true) || htmlText.contains("Invalid", true))
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
