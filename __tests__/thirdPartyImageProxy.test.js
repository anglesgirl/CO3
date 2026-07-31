import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'main/web/worksScreen/fetchChapter.js'),
  'utf8',
);

describe('third-party chapter image proxy', () => {
  it('routes third-party images through the WordPress image proxy', () => {
    expect(source).toContain("const WORDPRESS_PROXY_HOSTS = new Set(['i2.wp.com', 'i3.wp.com'])");
    expect(source).toContain('function rewriteThirdPartyImageUrls(chapterHtml)');
    expect(source).toContain('const proxiedChapterHtml = rewriteThirdPartyImageUrls(chapterHtml)');
    expect(source).toContain('https://i2.wp.com/${url.href.replace');
    expect(source).toContain("const proxyUrl = 'https://i2.wp.com/' + originalUrl.replace");
    expect(source).toContain("/^https?:\\/\\//i, ''");
    expect(source).toContain("message: '[image proxy] ' + message");
    expect(source).toContain("log('initialized; images=' + document.images.length)");
  });

  it('does not proxy AO3 or an existing WordPress proxy URL', () => {
    expect(source).toContain("!parsed.hostname.endsWith('.' + AO3_HOST)");
    expect(source).toContain('!WORDPRESS_PROXY_HOSTS.has(parsed.hostname)');
  });

  it('falls back to the original image after a proxy failure', () => {
    expect(source).toContain('image.dataset.co3OriginalSrc = originalUrl');
    expect(source).toContain('image.src = image.dataset.co3OriginalSrc');
  });
});
