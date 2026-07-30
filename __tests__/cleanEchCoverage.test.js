import fs from 'fs';
import path from 'path';

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('clean ECH integration', () => {
  it('starts from the official B0.0.18 login flow and routes its AO3 requests through ECH', () => {
    const login = read('main/web/account/login.js');
    expect(login).toContain("formData.append('user[login]', username)");
    expect(login).toContain("fetch(await echUrl('https://archiveofourown.org/users/login')");
    expect(login).toContain("new URL(response.url).pathname === '/users/login'");
    expect(login).not.toContain('resolveAuthenticatedUsername');
  });

  it('uses a narrow loopback route for weserv images and allows only intended hosts', () => {
    const proxy = read('ech/echproxy/echproxy.go');
    const images = read('main/web/imageProxy.js');
    expect(proxy).toContain('const localRoutePrefix = "/__ech__/"');
    expect(proxy).toContain('host == "images.weserv.nl"');
    expect(proxy).toContain('strings.HasSuffix(host, ".archiveofourown.org")');
    expect(images).toContain('/__ech__/images.weserv.nl/');
    expect(images).toContain("new URL(rawUrl, 'https://archiveofourown.org/')");
  });

  it('uses the curated edge IP pool for secondary protected hosts', () => {
    const proxy = read('ech/echproxy/echproxy.go');
    expect(proxy).toContain('The configured pool is vetted AS13335 IPs');
    expect(proxy).toContain('for _, ip := range custom');
    expect(proxy).toContain('for _, ip := range hc.ips');
  });

  it('does not assume a second bookmark list and carries the saved session for forms', () => {
    const bookmarks = read('main/web/other/bookmarks.js');
    expect(bookmarks).toContain('Array.from(olElements).flatMap');
    expect(bookmarks).toContain('await getSessionHeaders()');
    expect(bookmarks).toContain('fetch(await echUrl(url)');
  });

  it('loads the Chinese translation as a selectable app language', () => {
    const language = read('main/storage/LanguageManager.js');
    expect(language).toContain("import zh from '../../languages/zh.json'");
    expect(language).toContain("code: 'zh'");
    expect(() => JSON.parse(read('languages/zh.json'))).not.toThrow();
  });
});
