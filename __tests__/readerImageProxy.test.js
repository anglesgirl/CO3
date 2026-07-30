import fs from 'fs';
import path from 'path';
import { proxiedImageUrl } from '../main/web/imageProxy';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('reader image proxy', () => {
  it('encodes absolute and AO3-relative remote image URLs', () => {
    expect(proxiedImageUrl('https://example.com/a b.png')).toBe(
      'https://images.weserv.nl/?url=https%3A%2F%2Fexample.com%2Fa%2520b.png',
    );
    expect(proxiedImageUrl('/images/work.png')).toBe(
      'https://images.weserv.nl/?url=https%3A%2F%2Farchiveofourown.org%2Fimages%2Fwork.png',
    );
  });

  it('does not proxy local, embedded, or already proxied images', () => {
    expect(proxiedImageUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
    expect(proxiedImageUrl('file:///chapter/image.png')).toBe('file:///chapter/image.png');
    expect(proxiedImageUrl('https://images.weserv.nl/?url=x')).toBe(
      'https://images.weserv.nl/?url=x',
    );
  });

  it('injects rewriting before reader content loads', () => {
    const reader = read('main/screens/chapterReader.jsx');
    const helper = read('main/web/imageProxy.js');
    expect(reader).toContain("getEchBaseUrl");
    expect(reader).toContain("IMAGE_PROXY_SCRIPT.replace('__CO3_ECH_BASE__', echBaseUrl)");
    expect(helper).toContain("querySelectorAll('img')");
    expect(helper).toContain("removeAttribute('srcset')");
    expect(helper).toContain('MutationObserver');
  });
});
