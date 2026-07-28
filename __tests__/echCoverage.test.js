import fs from 'fs';
import path from 'path';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('AO3 ECH coverage', () => {
  it('never caches or uses the direct WebView fallback for AO3 requests', () => {
    const source = read('main/web/requestManager.js');
    expect(source).not.toContain('enableCFMode');
    expect(source).not.toContain('fetchViaWebView');
    expect(source).toContain('new ProtectedConnectionError');
    expect(source).toContain('cdn-cgi/challenge-platform');
    expect(source).toContain('429');
  });

  it('blocks Android AO3 traffic when the ECH proxy is unavailable', () => {
    const source = read('main/web/echKy.js');
    expect(source).toContain('async function requireEchBase');
    expect(source).toContain("code = 'ECH_REQUIRED'");
    expect(source).toContain("if (Platform.OS === 'android')");
    expect(source).not.toContain('if (!base) return url;');
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
