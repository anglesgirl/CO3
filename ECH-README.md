# CO3 + ECH (Encrypted Client Hello)

This fork adds an **on-device ECH front proxy** so CO3 can reach
`archiveofourown.org` (behind Cloudflare) over a TLS 1.3 handshake whose SNI is
hidden with ECH. The goal is to defeat SNI-based blocking (e.g. GFW resets) on
the app's main content-fetching path.

## How it works

```
 ky.get("https://archiveofourown.org/…")
        │  (echKy rewrites AO3 URLs)
        ▼
 http://127.0.0.1:<port>              ← plain HTTP on loopback
        │  (native EchProxy module → gomobile AAR)
        ▼
 Go reverse proxy (crypto/tls, Go 1.24)
        │  TLS 1.3 + EncryptedClientHelloConfigList, retry_configs self-heal
        ▼
 https://archiveofourown.org  (SNI encrypted)
```

## What was added

| Piece | Path |
|-------|------|
| Go ECH proxy (gomobile-bindable) | `ech/echproxy/echproxy.go`, `ech/go.mod` |
| Native module (starts the proxy) | `android/app/src/main/java/com/co3/ech/EchProxyModule.kt`, `EchProxyPackage.kt` |
| Package registration | `android/app/src/main/java/com/co3/MainApplication.kt` |
| Gradle wiring (AAR dependency) | `android/app/build.gradle` |
| ky routing (drop-in `ky` instance) | `main/web/echKy.js` |
| Request sites switched to `echKy` | `requestManager.js`, `fetchAuthenticityToken.js`, `NativeDownload.js`, `fetchComments.js` |
| CI: build AAR + APK | `.github/workflows/android-ech.yml` |

The `echproxy.aar` is **not committed** — CI regenerates it with
`gomobile bind` on every build (see `.gitignore`).

## Scope / known limitations (stage 1)

- **Android only.** iOS ECH needs a Network Extension (`NEAppProxyProvider`) and
  is not wired yet. `echKy.js` falls back to direct requests on iOS.
- **ky path only.** The `react-native-webview` fallback (used for Cloudflare
  challenges) is left untouched and does **not** go through ECH — a plain HTTP
  proxy can't hide the SNI of WebView's own TLS without a local MITM CA.
- **Cookies / login** are held in the Go proxy's in-memory cookie jar for the app
  session. They are lost on app restart (re-login needed). Persisting the jar is
  a follow-up.
- **Graceful fallback:** if the proxy can't start or the ECH handshake fails, the
  app still works via direct requests (no bypass, but not broken).

## Verifying ECH actually worked

The native module exposes `NativeModules.EchProxy.status()` which returns the
latest handshake line, e.g. `upstream handshake ok ECHAccepted=true …`.
`ECHAccepted=true` means the encrypted-SNI handshake was accepted by AO3.
This must be tested **from inside the censored network** to be meaningful.

## Building locally (optional)

```
# 1. build the AAR
cd ech
go get golang.org/x/mobile/bind@latest
gomobile bind -target=android -androidapi 24 -o ../android/app/libs/echproxy.aar ./echproxy
# 2. build the app
cd ../android
./gradlew assembleRelease
```

Requires Go 1.24+, gomobile, Android SDK + NDK 27.1.12297006.
