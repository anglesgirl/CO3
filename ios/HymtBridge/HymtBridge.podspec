Pod::Spec.new do |s|
  s.name             = 'HymtBridge'
  s.version          = '0.1.0'
  s.summary          = 'Bridge llama.cpp on-device translation to React Native (iOS)'
  s.description      = 'Exposes a llama.cpp runner to JS as NativeModules.Hymt, mirroring the Android HymtModule so deviceTranslate.js works unchanged on both platforms.'
  s.homepage         = 'https://github.com/anglesgirl/CO3'
  s.license          = { :type => 'MIT' }
  s.author           = { 'anglesgirl' => 'anglesgirl@users.noreply.github.com' }
  s.source           = { :path => '.' }
  s.ios.deployment_target = '15.1'

  # 只取本目录顶层源码：不能用 '**/*.h'，否则会把
  # llama.xcframework/*/Headers/*.h 也当成 pod 自己的头文件，与 vendored_frameworks 冲突。
  # 注意必须含 .m —— HymtBridge.m 里的 RCT_EXTERN_MODULE 注册宏丢了，
  # 运行时 NativeModules.Hymt 就是 undefined（静默失效）。
  s.source_files = '*.{h,m,mm,swift}'

  # Swift ↔ ObjC++ 混合 pod：需要 module 定义，RN 才能按 @objc(Hymt) 找到这个类。
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    # llama.cpp 是 C++17 代码，HymtLlama.mm 直接 include 它的头文件
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    # 关掉 bitcode：llama.xcframework 由 CI 现编，不含 bitcode 段
    'ENABLE_BITCODE' => 'NO',
    # CI 只编真机切片（ios-arm64）；要是以后加回模拟器构建，
    # 这里要一起补 ios-arm64-simulator 的路径，否则模拟器上找不到 llama.h
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/llama.xcframework/ios-arm64/llama.framework/Headers"',
  }

  # llama.xcframework 由 CI 在 pod install 之前编出来（见 .github/workflows/ios-build.yml）。
  # 本地直接 pod install 而没有先跑构建脚本的话，这里会找不到 xcframework。
  s.vendored_frameworks = 'llama.xcframework'

  # llama.cpp 是 C++，Swift 侧要显式链 libc++
  s.libraries = 'c++'

  # Metal / Accelerate：llama.cpp 的 Metal 后端靠它们加速（iOS 统一内存，收益很大）
  s.frameworks = 'Metal', 'MetalKit', 'Accelerate', 'Foundation'

  s.dependency 'React-Core'
end
