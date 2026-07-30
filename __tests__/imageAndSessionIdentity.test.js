import fs from 'fs';
import path from 'path';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('image route and current-session identity', () => {
  it('routes weserv images through the local proxy with Cloudflare shared ECH', () => {
    const imageProxy = read('main/web/imageProxy.js');
    const proxy = read('ech/echproxy/echproxy.go');
    const reader = read('main/screens/chapterReader.jsx');
    expect(reader).toContain("getEchBaseUrl");
    expect(imageProxy).toContain("/__ech__/${IMAGE_PROXY_HOST}/");
    expect(proxy).toContain('const localRoutePrefix = "/__ech__/"');
    expect(proxy).toContain('for _, ip := range custom');
    expect(proxy).toContain('fetchECHViaDoH(host, doh)');
    expect(proxy).toContain('using shared Cloudflare ECH config');
  });

  it('shows the canonical AO3 username in the current-session panel', () => {
    const loginScreen = read('main/screens/more/LoginScreen.jsx');
    expect(loginScreen).toContain('let canonicalUsername = await getUsername()');
    expect(loginScreen).toContain('resolveAuthenticatedUsername(sessionToken)');
    expect(loginScreen).toContain('username: canonicalUsername || storedCreds.username');
  });
});
