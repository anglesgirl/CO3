import fs from 'fs';
import path from 'path';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('Chinese-first interface cleanup', () => {
  it('defaults to Chinese and skips language and donation onboarding', () => {
    const language = read('main/storage/LanguageManager.js');
    const onboarding = read('main/onboard/MainOnboardScreen.jsx');
    expect(language).toContain("savedLang || 'zh'");
    expect(language).toContain("lng: 'zh'");
    expect(onboarding).not.toContain('Step2Screen');
    expect(onboarding).not.toContain('Step4Screen');
  });

  it('removes help and support links while keeping the upstream repository', () => {
    const more = read('main/screens/More.jsx');
    const about = read('main/screens/more/AboutScreen.jsx');
    const sideMenu = read('main/components/app/SideMenu.jsx');
    expect(more).not.toContain("handlePress('Help')");
    expect(about).toContain('https://github.com/tbvns/CO3');
    expect(about).not.toContain('/releases');
    expect(about).not.toContain('ko-fi.com');
    expect(about).not.toContain('tbvns.xyz');
    expect(sideMenu).not.toContain('archiveofourown.org/donate');
    expect(sideMenu).not.toContain('ko-fi.com');
  });

  it('opens all account flows on the official AO3 pages (no local forms)', () => {
    const screen = read('main/screens/more/LoginScreen.jsx');
    expect(screen).toContain("'screen_account_register'");
    expect(screen).toContain("'account_activate_button'");
    expect(screen).toContain("'/users/password/new'");
    expect(screen).toContain("'/invite_requests'");
    expect(screen).not.toContain('<TextInput'); // 本地表单已全部移除
  });

  it('does not retain known hard-coded English operation messages', () => {
    const files = [
      'main/app.jsx',
      'main/screens/Browse.jsx',
      'main/screens/GlobalSearchScreen.jsx',
      'main/screens/more/LoginScreen.jsx',
    ].map(read).join('\n');
    expect(files).not.toContain('>Logout<');
    expect(files).not.toContain('Error fetching fandoms');
    expect(files).not.toContain("Alert.alert('Error'");
    expect(files).not.toContain('"Clear Filters"');
  });
});
