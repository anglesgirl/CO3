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

class EchWebViewManager : SimpleViewManager<WebView>() {
    override fun getName() = "EchWebView"

    override fun createViewInstance(reactContext: ThemedReactContext): WebView {
        val wv = WebView(reactContext)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.allowFileAccess = false
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)
        // 登录页劫持：把 POST body 丢失的问题绕过（注入 JS 拦截提交，改走 OkHttp/ECH）
        wv.addJavascriptInterface(object {
            @JavascriptInterface fun onLoginHijacked(msg: String) {
                android.util.Log.i("CO-ECH", "login hijack: "+msg.take(80))
                try { com.co3.Diagnostics.event("webview_login_hijack", mapOf("msg" to msg.take(120))) } catch(_:Exception){}
            }
        }, "CoBridge")
        wv.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val ech = CoWebViewHelper.intercept(request)
                if (ech != null) return ech
                return super.shouldInterceptRequest(view, request)
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return false
            }
            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                // 注入劫持：拦截 #new_user 的提交，先让原生打日志，POST 仍走直连（已 bypass ECH），不阻塞
                try {
                    view.evaluateJavascript("""
                    (function(){
                      var f=document.getElementById('new_user');
                      if(f && !f._coHijacked){ f._coHijacked=true; try{ window.CoBridge.onLoginHijacked('found new_user'); }catch(e){}
                      }
                    })();
                    """.trimIndent(), null)
                } catch(_:Exception){}
            }
        }
        return wv
    }

    @ReactProp(name = "sourceUrl")
    fun setSourceUrl(view: WebView, url: String?) {
        if (!url.isNullOrEmpty()) view.loadUrl(url)
    }
}
