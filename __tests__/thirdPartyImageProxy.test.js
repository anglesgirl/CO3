import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'main/web/worksScreen/fetchChapter.js'),
  'utf8',
);

describe('third-party chapter image proxy', () => {
  it('routes third-party chapter images through Baidu and preserves the original URL', () => {
    expect(source).toContain("const BAIDU_PROXY_HOST = 'image.baidu.com'");
    expect(source).toContain("image.dataset.co3OriginalSrc = originalUrl");
    expect(source).toContain("https://image.baidu.com/search/down?url='");
    expect(source).toContain("encodeURIComponent(originalUrl)");
  });

  it('does not proxy AO3 or existing Baidu image URLs', () => {
    expect(source).toContain("parsed.hostname !== AO3_HOST");
    expect(source).toContain("!parsed.hostname.endsWith('.' + AO3_HOST)");
    expect(source).toContain("parsed.hostname !== BAIDU_PROXY_HOST");
  });

  it('falls back to the original image after a proxy load failure', () => {
    expect(source).toContain("image.src = image.dataset.co3OriginalSrc");
  });
});
