# ECH Build Experience (2026-08)

## Key Learnings from co3 Integration Session

### 1. Build System
- **Use original build.gradle**: Multiple attempts to modify Android Gradle DSL failed (flatDir, isUniversalApk, applicationId issues). Original config most stable.
- **AAR dependency**: `implementation fileTree(dir: 'libs', include: ['*.aar'])` is the working notation.
- **Conscrypt**: `org.conscrypt:conscrypt-android:2.7-alpha` for BoringSSL native ECH provider.

### 2. GitHub Actions
- **co3 is public repo**: GitHub Actions public repo = unlimited minutes (not 2000/min limit for private repos).
- **Workflow triggers**: Push to `ech-integration` branch dispatches ECH test build.

### 3. ECH Integration Pattern
- **BoringSSL AAR**: `anglesgirl/ech-tls-android` Release snapshot → `android/app/libs/echproxy.aar`
- **DoH configuration**: Cloudflare Zero Trust Gateway location for DNS resolution.
- **Domain strategy**: Single domain `archiveofourown.org` with fail-closed ECH policy.
- **Verification**: `unzip -l classes.arm64-v8a.apk | grep -c "libgojni"` ≥ 1 → ECH module present.

### 4. User Preferences
- **Minimalist output**: 要点/表格，少 token
- **实测证据**: 结论必须基于实测，未验证标记【推测/未验证】
- **明确指示**: 用户给明确指示直接执行，不要反复确认或质疑
- **不重复失败**: 踩坑后主动整理文档防重复犯错

### 5. Files Modified in This Session
- `android/app/libs/echproxy.aar` - BoringSSL native ECH provider
- `.github/workflows/ech-test.yml` - GitHub Actions workflow
- `android/app/build.gradle` - Original config (unchanged, only AAR added)
- `android/app/src/main/java/com/co3/ech/EchManager.kt` - ECH initialization
- `android/app/src/main/AndroidManifest.xml` - Service declaration
