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

    const std = read('.github/workflows/android-build.yml');
    expect(std).toContain('arm64-v8a,armeabi-v7a');
    // 普通 build 不应再尝试 mv 不存在的 x86 产物
    expect(std).not.toContain('app-x86-release.apk');
    expect(std).not.toContain('app-x86_64-release.apk');
  });

  it('uses a new Android version so the previous installation is replaced', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionCode 21');
    expect(gradle).toContain('versionName "B0.0.21"');
  });
});
