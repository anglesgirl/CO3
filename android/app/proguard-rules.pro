# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in proguard-android.txt via the proguardFiles directive in build.gradle.

# ---- React Native core（RN 官方 consumer 规则大多随 AAR 自带，这里兜底）----
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep,allowobfuscation @interface com.facebook.proguard.annotations.KeepGettersAndSetters
-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
}
-keepclassmembers @com.facebook.proguard.annotations.KeepGettersAndSetters class * {
    void set*(***);
    *** get*();
}
-keep class * implements com.facebook.react.bridge.NativeModule { *; }
-keepclassmembers,includedescriptorclasses class * { native <methods>; }
-keepclassmembers class *  { @com.facebook.react.uimanager.annotations.ReactProp <methods>; }
-keepclassmembers class *  { @com.facebook.react.uimanager.annotations.ReactPropGroup <methods>; }
-dontwarn com.facebook.react.**
-keep,includedescriptorclasses class com.facebook.react.bridge.** { *; }
-keep class com.facebook.jni.** { *; }

# ---- Hermes JS engine ----
-keep class com.facebook.hermes.unicode.** { *; }
-keep class com.facebook.jni.** { *; }

# ---- gomobile ECH proxy（Go 生成的 Java 绑定，通过 JNI 反射调用）----
# 关键：minify 绝不能改这些类名/方法名，否则 EchProxyModule 桥接崩溃。
-keep class echproxy.** { *; }
-keep class go.** { *; }
-keep class com.anglesya.co3.ech.** { *; }
-dontwarn echproxy.**
-dontwarn go.**

# ---- 应用自身的 Kotlin 原生模块（EchProxyModule 等，被 RN 反射实例化）----
-keep class com.anglesya.co3.** { *; }

# ---- 三方原生库 ----
-keep class com.swmansion.reanimated.** { *; }
-keep class com.swmansion.rnscreens.** { *; }
-keep class com.swmansion.gesturehandler.** { *; }
-keep class com.horcrux.svg.** { *; }
-keep class com.oblador.vectoricons.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# ---- OkHttp / okio（RN 网络栈）----
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep class okio.** { *; }

# ---- 保留注解/泛型/行号（崩溃栈可读）----
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keepattributes SourceFile,LineNumberTable
