// echKy: a drop-in `ky` instance that routes archiveofourown.org traffic through
// the on-device ECH proxy (native module `EchProxy`, backed by the gomobile AAR).
//
// The proxy listens on http://127.0.0.1:<port> and re-originates each request to
// https://archiveofourown.org over a TLS handshake whose SNI is hidden with ECH.
// If the proxy can't start (non-Android build, missing native module, handshake
// failure) we fall back to a direct request so the app keeps working.

import ky from 'ky';
import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AO3_HOSTS = new Set(['archiveofourown.org', 'www.archiveofourown.org']);

// Default DoH endpoint (JSON API) used to fetch AO3's current ech= record.
// A reachable DoH is important behind the GFW — dns.google is usually blocked,
// which is why the default is a Cloudflare Gateway endpoint. User-overridable.
export const DEFAULT_DOH = 'https://0kbpekmcr1.cloudflare-gateway.com/dns-query';
const DOH_KEY = 'ech_doh';

let echBasePromise = null; // Promise<string|null> — memoised

// Returns the configured DoH endpoint. Unset -> default. Empty string means the
// user explicitly disabled DoH (proxy will use its baked-in config + retry_configs).
export async function getDoh() {
  try {
    const v = await AsyncStorage.getItem(DOH_KEY);
    return v === null ? DEFAULT_DOH : v;
  } catch {
    return DEFAULT_DOH;
  }
}

function startProxy() {
  echBasePromise = (async () => {
    if (Platform.OS !== 'android') return null; // iOS: not wired yet
    const mod = NativeModules.EchProxy;
    if (!mod || typeof mod.start !== 'function') return null;
    try {
      const doh = await getDoh();
      const port = await mod.start(0, doh); // 0 = auto-pick a free port
      const base = `http://127.0.0.1:${port}`;
      console.log(`[ECH] proxy started on ${base} (doh=${doh || '(none)'})`);
      return base;
    } catch (e) {
      console.warn('[ECH] proxy failed to start, using direct requests:', e?.message ?? e);
      return null;
    }
  })();
  return echBasePromise;
}

function getEchBase() {
  return echBasePromise || startProxy();
}

// Eagerly warm up the proxy so it's ready before the first AO3 request.
export function initEch() {
  getEchBase().catch(() => {});
}

// Latest native handshake/status line (e.g. "... ECHAccepted=true ...").
export async function getEchStatus() {
  const mod = NativeModules.EchProxy;
  if (!mod || typeof mod.status !== 'function') return 'unavailable';
  try {
    return await mod.status();
  } catch {
    return 'error';
  }
}

// Change the DoH endpoint and restart the proxy with it. Pass '' to disable DoH.
export async function setDoh(doh) {
  await AsyncStorage.setItem(DOH_KEY, doh ?? '');
  const mod = NativeModules.EchProxy;
  try {
    if (mod?.stop) await mod.stop();
  } catch {}
  echBasePromise = null;
  return startProxy();
}

const echKy = ky.create({
  // Generous timeout: the first request may have to bootstrap the ECH handshake.
  timeout: 30000,
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
        return new Request(base + u.pathname + u.search, request);
      },
    ],
  },
});

// echSelfTest forces a request through the ECH proxy to archiveofourown.org and
// returns a human-readable result including the native handshake line
// (look for "ECHAccepted=true"). Used by the Debug screen.
export async function echSelfTest() {
  const doh = await getDoh();
  const base = await getEchBase();
  if (!base) {
    return `ECH proxy unavailable (non-Android or failed to start).`;
  }
  try {
    const res = await echKy.get('https://archiveofourown.org/', { timeout: 30000 });
    const status = await getEchStatus();
    return `OK — HTTP ${res.status} via ${base}\nDoH: ${doh || '(none)'}\n${status}`;
  } catch (e) {
    const status = await getEchStatus();
    return `Request failed: ${e?.message ?? e}\nDoH: ${doh || '(none)'}\nStatus: ${status}`;
  }
}

// Warm up the proxy as soon as this module is imported (app startup).
initEch();

export default echKy;
