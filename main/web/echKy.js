// echKy: a drop-in `ky` instance that routes archiveofourown.org traffic through
// the on-device ECH proxy (native module `EchProxy`, backed by the gomobile AAR).
//
// The proxy listens on http://127.0.0.1:<port> and re-originates each request to
// https://archiveofourown.org over a TLS handshake whose SNI is hidden with ECH.
// We rewrite only AO3 URLs; everything else goes out normally. If the proxy can't
// start (non-Android build, missing native module, handshake failure), we fall
// back to a direct request so the app keeps working (just without ECH).

import ky from 'ky';
import { NativeModules, Platform } from 'react-native';

const AO3_HOSTS = new Set(['archiveofourown.org', 'www.archiveofourown.org']);

let echBasePromise = null; // Promise<string|null> — memoised

// Starts the native proxy once and resolves to its base URL, or null on failure.
function getEchBase() {
  if (echBasePromise) return echBasePromise;

  echBasePromise = (async () => {
    if (Platform.OS !== 'android') return null; // iOS: not wired yet
    const mod = NativeModules.EchProxy;
    if (!mod || typeof mod.start !== 'function') return null;
    try {
      const port = await mod.start(0); // 0 = auto-pick a free port
      const base = `http://127.0.0.1:${port}`;
      console.log(`[ECH] proxy started on ${base}`);
      return base;
    } catch (e) {
      console.warn('[ECH] proxy failed to start, using direct requests:', e?.message ?? e);
      return null;
    }
  })();

  return echBasePromise;
}

// Returns the latest proxy status line (e.g. "ECHAccepted=true ...") for debugging.
export async function getEchStatus() {
  const mod = NativeModules.EchProxy;
  if (!mod || typeof mod.status !== 'function') return 'unavailable';
  try {
    return await mod.status();
  } catch {
    return 'error';
  }
}

// Eagerly warm up the proxy (call once at app startup). Optional.
export function initEch() {
  getEchBase().catch(() => {});
}

const echKy = ky.create({
  hooks: {
    beforeRequest: [
      async (request) => {
        const base = await getEchBase();
        if (!base) return; // no proxy -> leave request untouched (direct)
        let u;
        try {
          u = new URL(request.url);
        } catch {
          return;
        }
        if (!AO3_HOSTS.has(u.hostname)) return;
        const proxied = base + u.pathname + u.search;
        // Reuse method, headers, body from the original request.
        return new Request(proxied, request);
      },
    ],
  },
});

export default echKy;
