module github.com/anglesgirl/ech-proxy-android

go 1.26

// 必须 >= go1.26.5：修 CVE-2026-42505（crypto/tls ECH 隐私泄漏 ——
// 会泄漏 PSK 身份，使旁路观察者能去匿名化域名，等于 ECH 失效）。
// 客户端 ECH 的 API 自 go1.24 起未变（tls.Config.EncryptedClientHelloConfigList），
// 所以功能不依赖新版，纯为安全。
toolchain go1.26.8
