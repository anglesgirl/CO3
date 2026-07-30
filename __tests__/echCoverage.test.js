import fs from 'fs';
import path from 'path';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('AO3 ECH coverage', () => {
  it('uses an ECH-protected WebView without restoring the 24-hour cache', () => {
    const manager = read('main/web/requestManager.js');
    const webView = read('main/web/WebviewFetcher.jsx');
    expect(manager).not.toContain('enableCFMode');
    expect(manager).not.toContain('cf_domains');
    expect(manager).toContain('fetchViaProtectedWebView');
    expect(manager).toContain('cdn-cgi/challenge-platform');
    expect(manager).toContain('429');
    expect(webView).toContain("import { echUrl }");
    expect(webView).toContain('await echUrl(item.url)');
    expect(webView).toContain('protectNavigation');
    expect(webView).not.toContain('setSource({ uri: currentRef.current.url })');
  });

  it('shows the protected challenge instead of reloading it on confirmation', () => {
    const source = read('main/web/WebviewFetcher.jsx');
    expect(source).toContain('currentRef.current.cfWarning = false');
    expect(source).toContain('setVisible(true)');
    expect(source).not.toContain('const onWarningDismiss = () => {\n    setShowCFWarning(false);\n    loadCurrent();');
  });

  it('blocks Android AO3 traffic when the ECH proxy is unavailable', () => {
    const source = read('main/web/echKy.js');
    expect(source).toContain('async function requireEchBase');
    expect(source).toContain("code = 'ECH_REQUIRED'");
    expect(source).toContain("if (Platform.OS === 'android')");
    expect(source).not.toContain('if (!base) return url;');
  });

  it('persists only an expiring public ECH configuration cache on Android', () => {
    const proxy = read('ech/echproxy/echproxy.go');
    const module = read('android/app/src/main/java/com/co3/ech/EchProxyModule.kt');
    expect(proxy).toContain('type publicECHCache struct');
    expect(proxy).toContain('publicECHCacheTTL = 12 * time.Hour');
    expect(proxy).toContain('storePublicECHCache(cachePath, host, b)');
    expect(proxy).toContain('storePublicECHCache(cachePath, sni, rej.RetryConfigList)');
    expect(proxy).toContain('cookies, credentials, private keys');
    expect(module).toContain('ech-public-config.json');
  });

  it('covers AO3 ky and getUrl paths through the shared ECH client', () => {
    const ky = read('main/web/echKy.js');
    const manager = read('main/web/requestManager.js');
    const loginToken = read('main/web/account/fetchAuthenticityToken.js');
    const account = read('main/web/account/accountRequests.js');
    const comments = read('main/web/worksScreen/fetchComments.js');
    expect(ky).toContain('const echKy = ky.create');
    expect(ky).toContain('new Request(base + u.pathname + u.search, request)');
    expect(manager).toContain("from './echKy'");
    expect(loginToken).toContain("import ky from '../echKy'");
    expect(account).toContain("import ky, { echUrl } from '../echKy'");
    expect(comments).toContain("import ky, { echUrl } from '../echKy'");
  });

  it('checks the real works endpoint in the ECH self-test', () => {
    const source = read('main/web/echKy.js');
    expect(source).toContain("echKy.get('https://archiveofourown.org/works'");
    expect(source).toContain("includes('work blurb')");
    expect(source).toContain('/works HTTP');
  });

  it('preserves the protected connection error for the Browse retry screen', () => {
    const source = read('main/screens/Browse.jsx');
    expect(source).toContain('code: err.code');
    expect(source).toContain('{userErrorMessage(error, t)}');
  });

  it('routes bookmark creation through echUrl', () => {
    const source = read('main/web/other/bookmarks.js');
    expect(source).toContain("import { echUrl }");
    expect(source).toContain('fetch(await echUrl(url)');
    expect(source).toContain('fetch(await echUrl(postUrl)');
  });

  it('routes both autocomplete implementations through echUrl', () => {
    const sources = [
      read('main/web/browse/autoComplete.js'),
      read('main/screens/advancedSearch.jsx'),
    ];
    for (const source of sources) {
      expect(source).toContain("import { echUrl }");
      expect(source).toContain('fetch(await echUrl(url)');
    }
  });

  it('uses the ECH download helper instead of direct RNFS downloads', () => {
    const screen = read('main/screens/workScreen.jsx');
    expect(screen).toContain('nativeDownload(workId, format');
    expect(screen).not.toContain('RNFS.downloadFile({ fromUrl: url');
  });

  it('routes AO3 avatar images through echUrl', () => {
    const userInfo = read('main/web/user/getUserInfo.js');
    const comments = read('main/web/worksScreen/fetchComments.js');
    expect(userInfo).toContain('await echUrl(');
    expect(comments).toContain('await echUrl(');
  });

  it('does not assume a second work list exists', () => {
    const source = read('main/web/user/userWorks.js');
    expect(source).toContain('flatMap');
    expect(source).not.toContain('olElements[1]');
  });
});
