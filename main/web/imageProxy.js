const IMAGE_PROXY_PREFIX = 'https://images.weserv.nl/?url=';
const IMAGE_PROXY_HOST = 'images.weserv.nl';
const READER_BASE_URL = 'https://archiveofourown.org/';

export function proxiedImageUrl(rawUrl, baseUrl = READER_BASE_URL) {
  if (!rawUrl || /^(data|blob|file):/i.test(rawUrl)) return rawUrl;
  try {
    const resolved = new URL(rawUrl, baseUrl);
    if (!/^https?:$/.test(resolved.protocol)) return rawUrl;
    if (resolved.hostname.toLowerCase() === 'images.weserv.nl') return rawUrl;
    return IMAGE_PROXY_PREFIX + encodeURIComponent(resolved.href);
  } catch {
    return rawUrl;
  }
}

export const IMAGE_PROXY_SCRIPT = `
(function () {
  // Replaced by React Native with the local ECH proxy base URL. The upstream
  // service is Cloudflare-fronted; route it through the same shared ECH
  // configuration and configured AS13335 edge IPs as AO3.
  const loopback = '__CO3_ECH_BASE__';
  const prefix = loopback !== '__CO3_ECH_BASE__'
    ? loopback + '/__ech__/${IMAGE_PROXY_HOST}/?url='
    : '';
  const baseUrl = '${READER_BASE_URL}';

  function proxyUrl(rawUrl) {
    if (!rawUrl || /^(data|blob|file):/i.test(rawUrl)) return rawUrl;
    try {
      const resolved = new URL(rawUrl, baseUrl);
      if (!/^https?:$/.test(resolved.protocol)) return rawUrl;
      if (!prefix) return rawUrl;
      // Re-route already proxied images too; otherwise a cached/rendered
      // weserv URL would bypass the loopback ECH path.
      if (resolved.hostname.toLowerCase() === '${IMAGE_PROXY_HOST}') {
        return loopback + '/__ech__/${IMAGE_PROXY_HOST}' + resolved.pathname + resolved.search;
      }
      return prefix + encodeURIComponent(resolved.href);
    } catch (_) {
      return rawUrl;
    }
  }

  function rewriteImage(image) {
    if (!image.matches || !image.matches('img')) return;
    const rawUrl = image.getAttribute('src') || image.getAttribute('data-src');
    const nextUrl = proxyUrl(rawUrl);
    if (nextUrl && nextUrl !== rawUrl) image.setAttribute('src', nextUrl);
    image.removeAttribute('srcset');
    image.removeAttribute('data-srcset');
    image.removeAttribute('data-src');
  }

  function rewriteImages(root) {
    if (root.nodeType === 1 && root.matches('img')) rewriteImage(root);
    if (root.querySelectorAll) root.querySelectorAll('img').forEach(rewriteImage);
  }

  function start() {
    rewriteImages(document);
    new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.type === 'attributes') rewriteImage(mutation.target);
        mutation.addedNodes.forEach(rewriteImages);
      });
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset'],
    });
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  true;
})();
`;
