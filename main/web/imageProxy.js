// images.weserv.nl is Cloudflare-fronted. The reader rewrites image requests
// through the on-device ECH proxy so both its DNS lookup and TLS ClientHello
// use the configured DoH/ECH/AS13335 route.
const IMAGE_PROXY_HOST = 'images.weserv.nl';
const AO3_BASE = 'https://archiveofourown.org/';

export const imageProxyScript = (loopbackBase = '') => `
(function () {
  const base = ${JSON.stringify(loopbackBase)};
  const prefix = base ? base + '/__ech__/${IMAGE_PROXY_HOST}/' : '';

  function rewrite(rawUrl) {
    if (!prefix || !rawUrl || /^(data|blob|file):/i.test(rawUrl)) return rawUrl;
    try {
      const url = new URL(rawUrl, '${AO3_BASE}');
      // First send original AO3/author image URLs through the established
      // Cloudflare image proxy, then route that proxy request through ECH.
      const weserv = url.hostname.toLowerCase() === '${IMAGE_PROXY_HOST}'
        ? url
        : new URL('https://${IMAGE_PROXY_HOST}/?url=' + encodeURIComponent(url.href));
      return prefix + weserv.pathname.replace(/^\\//, '') + weserv.search;
    } catch (_) {
      return rawUrl;
    }
  }

  function rewriteImage(image) {
    if (!image.matches || !image.matches('img')) return;
    const raw = image.getAttribute('src') || image.getAttribute('data-src');
    const next = rewrite(raw);
    if (next && next !== raw) image.setAttribute('src', next);
    image.removeAttribute('srcset');
    image.removeAttribute('data-srcset');
    image.removeAttribute('data-src');
  }

  function rewriteTree(root) {
    if (root.nodeType === 1 && root.matches('img')) rewriteImage(root);
    if (root.querySelectorAll) root.querySelectorAll('img').forEach(rewriteImage);
  }

  if (document.documentElement) {
    rewriteTree(document);
    new MutationObserver(mutations => mutations.forEach(m => {
      if (m.type === 'attributes') rewriteImage(m.target);
      m.addedNodes.forEach(rewriteTree);
    })).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset'],
    });
  }
  true;
})();
`;
