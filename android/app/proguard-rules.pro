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
