Pod::Spec.new do |s|
  s.name             = 'EchProxyBridge'
  s.version          = '0.1.0'
  s.summary          = 'Bridge gomobile ECH proxy to React Native (iOS)'
  s.description      = 'Exposes the gomobile-built echproxy framework to JS via RCTBridgeModule, mirroring the Android EchProxyModule.'
  s.homepage         = 'https://github.com/anglesgirl/CO3'
  s.license          = { :type => 'MIT' }
  s.author           = { 'anglesgirl' => 'anglesgirl@users.noreply.github.com' }
  s.source           = { :path => '.' }
  s.ios.deployment_target = '15.1'

  # 只取本目录顶层源码：不能用 '**/*.h'，否则会把
  # Echproxy.xcframework/*/Headers/*.h 也当成 pod 自己的头文件编译，
  # 与 vendored_frameworks 冲突。
  s.source_files = '*.{h,m,mm,swift}'

  # Swift ↔ ObjC 混合 pod：需要 module 定义，RCT_EXTERN_REMAP_MODULE 才能
  # 找到 @objc(EchProxyModule) 的 Swift 类。
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_VERSION' => '5.0',
  }

  # gomobile bind -target=ios produces Echproxy.xcframework in this dir (built
  # by CI before pod install; see .github/workflows/ios-build.yml).
  s.vendored_frameworks = 'Echproxy.xcframework'

  s.dependency 'React-Core'
end
