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

// Domain whose TXT record carries remote settings, so end users can pull a
// working DoH endpoint / edge IPs with one tap instead of understanding DoH.
// Publish a TXT record on this name, e.g.:
//   v=co3ech1; doh=https://example.com/dns-query; ip=104.20.8.2,104.20.9.2
// Set this to your own domain before shipping builds.
export const DEFAULT_CONFIG_DOMAIN = 'co3.xn--oiqt18e8e2a.eu.org';

const DOH_KEY = 'ech_doh';
const IP_KEY = 'ech_ip';
const CONFIG_DOMAIN_KEY = 'ech_config_domain';
// Set once the user edits DoH/IP by hand — remote config must not clobber that.
const MANUAL_KEY = 'ech_manual_override';
// Last remote values we applied, so we only restart when they actually change.
const LAST_REMOTE_KEY = 'ech_last_remote';

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

// Optional comma-separated list of preferred Cloudflare edge IPs. Empty = use DNS.
// Custom IPs only change which edge we connect to; SNI/ECH stay the same.
export async function getCustomIPs() {
  try {
    return (await AsyncStorage.getItem(IP_KEY)) ?? '';
  } catch {
    return '';
  }
}

function startProxy() {
  echBasePromise = (async () => {
    if (Platform.OS !== 'android') return null; // iOS: not wired yet
    const mod = NativeModules.EchProxy;
    if (!mod || typeof mod.start !== 'function') return null;
    try {
      const doh = await getDoh();
      const ips = await getCustomIPs();
      const port = await mod.start(0, doh, ips); // 0 = auto-pick a free port
      const base = `http://127.0.0.1:${port}`;
      console.log(`[ECH] proxy started on ${base} (doh=${doh || '(none)'}, ip=${ips || '(dns)'})`);
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

// Eagerly warm up the proxy so it's ready before the first AO3 request, then
// refresh the remote config in the background (never blocking startup).
export function initEch() {
  getEchBase().catch(() => {});
  syncRemoteConfig().catch(() => {});
}

// Validates a remote value before we trust it — a broken TXT record should not
// be able to break every install.
function isValidDoh(s) {
  return typeof s === 'string' && /^https:\/\/[^\s]+$/i.test(s);
}
function isValidIPList(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  return s
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .every(x => /^[0-9.]+$/.test(x) || /^[0-9a-f:]+$/i.test(x));
}

// syncRemoteConfig pulls the operator's TXT record and applies it silently.
// Skipped entirely when the user has set things by hand. Failures are ignored:
// we keep whatever settings already work.
export async function syncRemoteConfig() {
  if (Platform.OS !== 'android') return;
  const domain = await getConfigDomain();
  if (!domain) return;
  if (await hasManualOverride()) {
    console.log('[ECH] manual override set — skipping remote config');
    return;
  }

  let cfg;
  try {
    cfg = await fetchRemoteConfig(domain);
  } catch (e) {
    console.log('[ECH] remote config unavailable:', e?.message ?? e);
    return; // keep last known-good settings
  }

  const next = {
    doh: isValidDoh(cfg.doh) ? cfg.doh : null,
    ip: isValidIPList(cfg.ip) ? cfg.ip : null,
    tr: isValidDoh(cfg.tr) ? cfg.tr : null, // same https:// URL validation
  };
  if (!next.doh && !next.ip && !next.tr) return;

  // Only restart the proxy if something actually changed.
  let prev = {};
  try {
    prev = JSON.parse((await AsyncStorage.getItem(LAST_REMOTE_KEY)) || '{}');
  } catch {}
  if (prev.doh === next.doh && prev.ip === next.ip && prev.tr === next.tr) return;

  if (next.doh) await AsyncStorage.setItem(DOH_KEY, next.doh);
  if (next.ip) await AsyncStorage.setItem(IP_KEY, next.ip);
  // Translation endpoint lives in translate.js but ships through the same record.
  if (next.tr) await AsyncStorage.setItem('translate_endpoint', next.tr);
  await AsyncStorage.setItem(LAST_REMOTE_KEY, JSON.stringify(next));
  console.log('[ECH] applied remote config:', JSON.stringify(next));

  // Only the proxy settings require a restart.
  if (next.doh !== prev.doh || next.ip !== prev.ip) await restartProxy();
}

// echUrl rewrites an AO3 URL so it goes through the local ECH proxy. Use it for
// raw fetch() calls (form POSTs, cookie-sensitive requests) that can't use the
// `echKy` instance. Falls back to the original URL when the proxy isn't running.
export async function echUrl(url) {
  try {
    const base = await getEchBase();
    if (!base) return url;
    const u = new URL(url);
    if (!AO3_HOSTS.has(u.hostname)) return url;
    return base + u.pathname + u.search;
  } catch {
    return url;
  }
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

// Restart the proxy so new settings take effect.
async function restartProxy() {
  const mod = NativeModules.EchProxy;
  try {
    if (mod?.stop) await mod.stop();
  } catch {}
  echBasePromise = null;
  return startProxy();
}

// Change the DoH endpoint and restart the proxy with it. Pass '' to disable DoH.
// `manual` marks it as a user edit, which stops remote config from overriding it.
export async function setDoh(doh, manual = true) {
  await AsyncStorage.setItem(DOH_KEY, doh ?? '');
  if (manual) await AsyncStorage.setItem(MANUAL_KEY, '1');
  return restartProxy();
}

// Set preferred edge IPs (comma-separated) and restart. Pass '' to use DNS.
export async function setCustomIPs(ips, manual = true) {
  await AsyncStorage.setItem(IP_KEY, ips ?? '');
  if (manual) await AsyncStorage.setItem(MANUAL_KEY, '1');
  return restartProxy();
}

// Whether the user has hand-edited the DoH/IP settings.
export async function hasManualOverride() {
  try {
    return (await AsyncStorage.getItem(MANUAL_KEY)) === '1';
  } catch {
    return false;
  }
}

// Clear the manual flag so remote config takes over again.
export async function clearManualOverride() {
  await AsyncStorage.removeItem(MANUAL_KEY);
}

// --- remote configuration (TXT record) ------------------------------------

export async function getConfigDomain() {
  try {
    const v = await AsyncStorage.getItem(CONFIG_DOMAIN_KEY);
    return v === null ? DEFAULT_CONFIG_DOMAIN : v;
  } catch {
    return DEFAULT_CONFIG_DOMAIN;
  }
}

export async function setConfigDomain(domain) {
  await AsyncStorage.setItem(CONFIG_DOMAIN_KEY, domain ?? '');
}

// Parses a TXT payload like:
//   v=co3ech1; doh=https://example.com/dns-query; ip=104.20.8.2,104.20.9.2
// Returns { doh, ip } with whatever keys were present.
export function parseRemoteConfig(txt) {
  const out = {};
  for (const line of String(txt).split('\n')) {
    for (const part of line.split(';')) {
      const i = part.indexOf('=');
      if (i === -1) continue;
      const k = part.slice(0, i).trim().toLowerCase();
      const v = part.slice(i + 1).trim();
      if (!v) continue;
      if (k === 'doh') out.doh = v;
      else if (k === 'ip' || k === 'ips') out.ip = v;
      else if (k === 'tr' || k === 'translate') out.tr = v;
    }
  }
  return out;
}

// Fetches the remote config TXT record. Uses the currently configured DoH (or
// the built-in default) for the lookup, so it works even with poisoned DNS.
export async function fetchRemoteConfig(domain) {
  const mod = NativeModules.EchProxy;
  if (!mod || typeof mod.fetchTxt !== 'function') {
    throw new Error('ECH native module unavailable');
  }
  const name = (domain ?? '').trim() || (await getConfigDomain());
  if (!name) throw new Error('No config domain set');
  const doh = (await getDoh()) || DEFAULT_DOH;
  const txt = await mod.fetchTxt(doh, name);
  const cfg = parseRemoteConfig(txt);
  if (!cfg.doh && !cfg.ip && !cfg.tr) {
    throw new Error(`TXT found but no doh=/ip=/tr= keys:\n${txt}`);
  }
  return { ...cfg, raw: txt };
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
  const t0 = Date.now();
  try {
    const res = await echKy.get('https://archiveofourown.org/', { timeout: 30000 });
    const ms = Date.now() - t0;
    const status = await getEchStatus();
    return `OK — HTTP ${res.status} in ${ms}ms via ${base}\nDoH: ${doh || '(none)'}\n${status}`;
  } catch (e) {
    const ms = Date.now() - t0;
    const status = await getEchStatus();
    return `Request failed after ${ms}ms: ${e?.message ?? e}\nDoH: ${doh || '(none)'}\nStatus: ${status}`;
  }
}

// Warm up the proxy as soon as this module is imported (app startup).
initEch();

export default echKy;
