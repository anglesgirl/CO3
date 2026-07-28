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

  it('uploads only the arm64-v8a APK', () => {
    const workflow = read('.github/workflows/android-ech.yml');
    expect(workflow).toContain('-PBUILD_ABI=arm64-v8a');
    expect(workflow).toContain('path: CO3-ECH-arm64-v8a.apk');
    expect(workflow).not.toContain('CO3-ECH-*.apk');
  });

  it('uses a new Android version so the previous installation is replaced', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionCode 20');
    expect(gradle).toContain('versionName "B0.0.20"');
  });
});
