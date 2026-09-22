# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# H3 原生库入口：JNI 按类名/方法名查找，混淆后必须保留（否则 native 侧找不到方法）
-keep class com.co3.ech.CoEchH3 { *; }
-keepclasseswithmembernames class com.co3.ech.CoEchH3 { native <methods>; }

# ---------------------------------------------------------------------------
# ⚠️ 以下规则当前【不生效】—— 因为 build.gradle 里
#     enableProguardInReleaseBuilds = false（R8 未开）。
#     但一旦有人把它改成 true，缺了这些规则就会**静默**弄坏 ECH：
#     R8 的破坏是无声的 —— 编译全绿，跑起来网络就是不通，且没有任何报错。
#     所以现在就把规则补上，别依赖「某个开关恰好是关着的」。
# ---------------------------------------------------------------------------

# Conscrypt 用【反射】从 X509TrustManager 上取 getNetworkSecurityPolicy()。
# 取不到就回落平台默认策略（Android API 36 = DISABLED），而 DISABLED 会让
# getEchOptions() 返回 null、enableEchBasedOnPolicy() 首行就 return ——
# 结果是 setEchConfigList 完全白设，ECH 扩展一个字节都不发（且完全静默）。
# 所以 PolicyTrustManager 上那个方法就是整套 ECH 的开关，绝不能改名或删除。
-keep class com.co3.ech.ConscryptEch$PolicyTrustManager { *; }
-keepclasseswithmembers class com.co3.ech.ConscryptEch$PolicyTrustManager {
    public <methods>;
}

# React Native 原生模块：@ReactMethod 由 JS 按名字调用，方法名被混淆 = 桥静默失效
# （症状：NativeModules.EchProxy / CoDiag / CoCookie 全部 undefined，功能无声消失）
-keepclassmembers class com.co3.ech.** { @com.facebook.react.bridge.ReactMethod <methods>; }
-keepclassmembers class com.co3.CoDiagModule { public *; }
-keepclassmembers class com.co3.CoCookieModule { public *; }
-keepclassmembers class com.co3.ech.EchWebViewManager { public *; }
-keepclassmembers class com.co3.ech.CoWebViewHelper { public *; }
