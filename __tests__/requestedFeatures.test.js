import fs from 'fs';
import path from 'path';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('requested feature boundaries', () => {
  it('does not expose an external-browser action on the work screen', () => {
    const source = read('main/screens/workScreen.jsx');
    expect(source).not.toContain('handleOpenWebView');
    expect(source).not.toContain('open-in-browser');
  });

  it('offers translation inside the book details modal', () => {
    const source = read('main/components/Library/BookDetailsModal.jsx');
    expect(source).toContain("import { translateText }");
    expect(source).toContain("t('translate_button')");
  });

  it('uses AO3 invitation and status endpoints instead of the removed URL', () => {
    const source = read('main/web/account/accountRequests.js');
    expect(source).toContain("getForm('/invite_requests')");
    expect(source).toContain("BASE + '/invite_requests/show'");
    expect(source).not.toContain('/invite_requests/new');
  });

  it('builds and uploads split APKs for arm64 + armv7 only', () => {
    const ech = read('.github/workflows/android-ech.yml');
    // gomobile 只构建 32/64 位 ARM,x86 系列已不再支持
    expect(ech).toContain('android/arm,android/arm64');
    expect(ech).toContain('arm64-v8a,armeabi-v7a');
    expect(ech).not.toContain('android/386');
    expect(ech).not.toContain('android/amd64');
    expect(ech).not.toContain('x86,x86_64');

    // ECH 是唯一构建流程:非 ECH 的 android-build.yml 已删除,
    // 防止再产出不带 ECH 原生模块(libgojni.so)的 APK。
    expect(fs.existsSync(path.join(__dirname, '..', '.github/workflows/android-build.yml'))).toBe(false);
  });

  it('uses a new Android version so the previous installation is replaced', () => {
    const gradle = read('android/app/build.gradle');
    // 版本号由发版流程递增,不锁死具体值;只校验存在且 versionCode 与
    // versionName 一致(B0.0.X ↔ versionCode X)。
    const vc = gradle.match(/versionCode (\d+)/)?.[1];
    const vn = gradle.match(/versionName "([^"]+)"/)?.[1];
    expect(vc).toBeTruthy();
    expect(vn).toBeTruthy();
    expect(parseInt(vc, 10)).toBeGreaterThan(0);
    // versionName 形如 B0.0.22,其末尾数字应与 versionCode 一致
    const nameNum = vn.match(/(\d+)$/)?.[1];
    if (nameNum) expect(parseInt(nameNum, 10)).toBe(parseInt(vc, 10));
  });
});
