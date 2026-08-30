package com.co3.ech

import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.ReactCookieJarContainer
import okhttp3.OkHttpClient

class ReactNativeEchFactory : OkHttpClientFactory {
    override fun createNewNetworkModuleClient(): OkHttpClient {
        return OkHttpClient.Builder()
            .cookieJar(ReactCookieJarContainer())
            .addInterceptor(CoEchInterceptor())
            .build()
    }
}
