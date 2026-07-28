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
    expect(about).toContain('https://anglesya.win/');
    expect(about).toContain('https://www.ao3.xyz/');
    expect(about).toContain('label="AO3.XYZ"');
    expect(about).toContain("t('screen_about_assisted_development')");
    expect(about).toContain("t('screen_about_idea_contributor')");
    expect(about).not.toContain('/releases');
    expect(about).not.toContain('ko-fi.com');
    expect(about).not.toContain('tbvns.xyz');
    expect(sideMenu).not.toContain('archiveofourown.org/donate');
    expect(sideMenu).not.toContain('ko-fi.com');
  });

  it('provides an invitation email lookup and removes verbose link tips', () => {
    const modal = read('main/components/Account/AccountSetupModal.jsx');
    expect(modal).toContain("t('account_queue_lookup')");
    expect(modal).not.toContain("t('account_paste_invite_hint')");
    expect(modal).not.toContain("t('account_activate_hint')");
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
