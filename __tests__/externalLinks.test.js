// AO3 链接不能丢给系统浏览器：外部浏览器是独立进程，拿不到 App 内的
// ECH 代理端口，在 DNS 被污染的网络里直连 archiveofourown.org 会失败。
// openExternalLink 负责区分：AO3 → 应用内 WebView（走代理）；其它 → 系统浏览器。

jest.mock('react-native', () => ({
  Linking: { openURL: jest.fn(async () => true) },
}));

import { Linking } from 'react-native';
import { openExternalLink, isAo3Url, AO3_HOSTS } from '../main/utils/openExternalLink';

describe('openExternalLink', () => {
  beforeEach(() => {
    Linking.openURL.mockClear();
  });

  it('recognises every AO3 host, including the download subdomain', () => {
    expect(isAo3Url('https://archiveofourown.org/works/123')).toBe(true);
    expect(isAo3Url('https://www.archiveofourown.org/')).toBe(true);
    expect(isAo3Url('https://download.archiveofourown.org/x.epub')).toBe(true);
    expect(isAo3Url('https://example.com/')).toBe(false);
    expect(isAo3Url('not a url')).toBe(false);
  });

  it('does NOT hand AO3 links to the system browser', async () => {
    for (const host of AO3_HOSTS) {
      const result = await openExternalLink(`https://${host}/works/456`);
      expect(result).toEqual({ opened: false, ao3: true });
    }
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it('opens non-AO3 links externally (those hosts are not blocked)', async () => {
    const result = await openExternalLink('https://example.com/page');
    expect(result).toEqual({ opened: true, ao3: false });
    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/page');
  });

  it('ignores empty input instead of throwing', async () => {
    await expect(openExternalLink('')).resolves.toEqual({ opened: false, ao3: false });
    await expect(openExternalLink(null)).resolves.toEqual({ opened: false, ao3: false });
    expect(Linking.openURL).not.toHaveBeenCalled();
  });
});
