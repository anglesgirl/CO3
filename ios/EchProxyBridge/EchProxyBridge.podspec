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

  s.source_files = '**/*.{h,m,mm,swift}'

  # gomobile bind -target=ios produces Echproxy.xcframework in this dir (built
  # by CI before pod install; see .github/workflows/ios-build.yml).
  s.vendored_frameworks = 'Echproxy.xcframework'

  s.dependency 'React-Core'
end
