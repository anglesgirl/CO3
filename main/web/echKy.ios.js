// echKy.ios: iOS 专用的 ECH 请求层（进程内直调，无代理端口）。
//
// 调用 Go 的 EchproxyFetch（gomobile），进程内直接发起带 ECH 的 HTTPS 请求，
// 不经过 127.0.0.1 代理。App 切后台回来后无需重启代理，每次请求独立。
//
// 接口与 Android 的 echKy.js 保持一致（echFetch / initEch / getEchStatus 等），
// 上层 ao3Transport.js 无感。

import ky from 'ky';
import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { trackEvent } from '../utils/analytics';
import { isEchProtectedUrl } from './WebviewFetcher';

// Default DoH endpoint (JSON API) used to fetch AO3's current ech= record.
export const DEFAULT_DOH = 'https://pieqllv9i7.cloudflare-gateway.com/dns-query';
export const DEFAULT_DOH_FALLBACKS = [
  DEFAULT_DOH,
  'https://m2b4x7vw98.cloudflare-gateway.com/dns-query',
  'https://dz1598pphb.cloudflare-gateway.com/dns-query',
];

export const DEFAULT_CONFIG_DOMAIN = 'ech-config.anglesgirl.eu.org';

const DOH_KEY = 'ech_doh';
const DOH2_KEY = 'ech_doh2';
const DOH3_KEY = 'ech_doh3';
const IP_KEY = 'ech_ip';
const CONFIG_DOMAIN_KEY = 'ech_config_domain';
const MANUAL_KEY = 'ech_manual_override';

let echInitPromise = null;
let echInitReady = false;
let lastInitError = null;
let lastInitAttempt = 0;
const INIT_RETRY_COOLDOWN_MS = 30000;
let initAttempts = 0;

export async function getDoh() {
  try {
    const v = await AsyncStorage.getItem(DOH_KEY);
    if (v === 'https://0kbpekmcr1.cloudflare-gateway.com/dns-query') {
      await AsyncStorage.setItem(DOH_KEY, DEFAULT_DOH);
      return DEFAULT_DOH;
    }
    return v === null ? DEFAULT_DOH : v;
  } catch {
    return DEFAULT_DOH;
  }
}

async function getDohCandidates() {
  const values = await Promise.all(
    [DOH_KEY, DOH2_KEY, DOH3_KEY].map(key => AsyncStorage.getItem(key)),
  );
  const retired = 'https://0kbpekmcr1.cloudflare-gateway.com/dns-query';
  return [...new Set(
    [...DEFAULT_DOH_FALLBACKS, ...values].filter(value => value !== retired && isValidDoh(value)),
  )];
}

export async function getCustomIPs() {
  try {
    return (await AsyncStorage.getItem(IP_KEY)) ?? '';
  } catch {
    return '';
  }
}

export function getLastStartError() {
  return lastInitError;
}

function shouldRetryInit() {
  return Date.now() - lastInitAttempt >= INIT_RETRY_COOLDOWN_MS;
}

function ensureInit() {
  if (echInitPromise) return echInitPromise;
  if (echInitReady) return Promise.resolve(true);
  if (!shouldRetryInit()) return Promise.resolve(false);
  return doInit();
}

function doInit() {
  lastInitAttempt = Date.now();
  initAttempts += 1;
  echInitPromise = (async () => {
    const mod = NativeModules.EchProxy;
    if (!mod || typeof mod.initEngine !== 'function') {
      const available = Object.keys(NativeModules || {}).length;
      lastInitError =
        `native module unavailable on ${Platform.OS} ` +
        `(EchProxy=${mod ? 'present-but-no-initEngine()' : 'undefined'}, ${available} native modules registered).`;
      console.warn(`[ECH] ${lastInitError}`);
      trackEvent('ech_init', { ok: false, error: `native_module_missing:${Platform.OS}` });
      return false;
    }
    const t0 = Date.now();
    try {
      const doh = (await getDohCandidates()).join(',');
      const ips = await getCustomIPs();
      console.log(`[ECH] init engine (attempt ${initAttempts}, doh=${doh || '(none)'}, ip=${ips || '(dns)'})`);
      await mod.initEngine(doh, ips, '');
      const ms = Date.now() - t0;
      console.log(`[ECH] engine initialized in ${ms}ms (in-process, no proxy port)`);
      lastInitError = null;
      echInitReady = true;
      trackEvent('ech_init', { ok: true, ms, doh: !!doh, ip: !!ips });
      return true;
    } catch (e) {
      const ms = Date.now() - t0;
      lastInitError = `initEngine() failed after ${ms}ms: ${e?.message ?? e}`;
      console.warn(`[ECH] init failed in ${ms}ms:`, e?.message ?? e);
      echInitReady = false;
      trackEvent('ech_init', { ok: false, ms, error: String(e?.message ?? e).slice(0, 120) });
      echInitPromise = null;
      return false;
    }
  })();
  return echInitPromise;
}

export function initEch() {
  if (echInitPromise) return;
  const warm = async () => {
    try {
      const ok = await ensureInit();
      if (!ok) return;
      const t0 = Date.now();
      try {
        await echKy.get('https://archiveofourown.org/', { timeout: 20000 }).text();
        console.log(`[ECH] warm-up complete in ${Date.now() - t0}ms`);
      } catch (e) {
        console.log(`[ECH] warm-up request failed in ${Date.now() - t0}ms: ${e?.message ?? e}`);
      }
    } catch {}
  };
  warm();
}

function isValidDoh(s) {
  return typeof s === 'string' && /^https:\/\/[^\s]+$/i.test(s);
}
function isValidIPList(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  return s.split(',').map(x => x.trim()).filter(Boolean)
    .every(x => /^[0-9.]+$/.test(x) || /^[0-9a-f:]+$/i.test(x));
}

export async function syncRemoteConfig() { return; }

// 兼容旧接口：无代理 base，返回标记。调用方不再用 base 拼 URL。
export function getEchBase() {
  return Promise.resolve('in-process');
}

export async function echFetch(input, init = {}) {
  let req;
  try {
    req = input instanceof Request ? input : new Request(input, init);
  } catch (e) {
    throw new Error(`ECH: 无法规范化请求（${String((e && e.message) || e)}）`);
  }
  const url = req.url;
  if (!isEchProtectedUrl(url)) return fetch(input, init);
  const ok = await ensureInit();
  if (!ok) throw new Error('ECH engine unavailable; refusing direct HTTPS request');
  return nativeFetch(req, init);
}

async function nativeFetch(req, init = {}) {
  const mod = NativeModules.EchProxy;
  const url = req.url;
  const method = req.method || 'GET';
  const headers = {};
  req.headers.forEach((v, k) => {
    if (String(k).toLowerCase() === 'cookie') return;
    headers[k] = v;
  });
  headers['User-Agent'] =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

  let bodyData = null;
  if (init.body && typeof init.body === 'string') {
    bodyData = Buffer.from(init.body, 'utf8');
  } else if (req.body) {
    try {
      const text = await req.clone().text();
      if (text) bodyData = Buffer.from(text, 'utf8');
    } catch {}
  }

  const t0 = Date.now();
  let result;
  try {
    result = await mod.fetch(url, method, headers, bodyData);
  } catch (e) {
    console.log(`[ECH] native fetch failed in ${Date.now() - t0}ms: ${e?.message ?? e}`);
    throw e;
  }
  const { status, headers: respHeaders, body } = result;
  try {
    console.log(`[ECH] → ${method} ${new URL(url).pathname} = ${status} in ${Date.now() - t0}ms (in-process)`);
  } catch {}
  const respBody = body ? Buffer.from(body, 'base64').toString('utf8') : '';
  return new Response(respBody, { status, statusText: String(status), headers: respHeaders });
}

export async function getEchStatus() {
  const mod = NativeModules.EchProxy;
  if (!mod || typeof mod.status !== 'function') return `unavailable: EchProxy 桥未注册`;
  try {
    const s = await mod.status();
    return `Go 引擎（进程内直调，无代理端口）\n${s}`;
  } catch (e) {
    return `engine status error: ${e?.message ?? e}`;
  }
}

export async function clearAuthCookies() { return clearSessionCookies(); }

export async function clearSessionCookies() {
  const mod = NativeModules.EchProxy;
  if (mod && typeof mod.clearSessionCookies === 'function') {
    try {
      await mod.clearSessionCookies();
      echInitReady = false;
      echInitPromise = null;
      return true;
    } catch (e) {
      console.warn('[ECH] clearSessionCookies failed:', e?.message ?? e);
      return false;
    }
  }
  return false;
}

export async function setDoh(doh, manual = true) {
  try {
    await AsyncStorage.setItem(DOH_KEY, doh);
    if (manual) await AsyncStorage.setItem(MANUAL_KEY, '1');
    echInitReady = false;
    echInitPromise = null;
  } catch {}
}

export async function setCustomIPs(ips, manual = true) {
  try {
    await AsyncStorage.setItem(IP_KEY, ips);
    if (manual) await AsyncStorage.setItem(MANUAL_KEY, '1');
    echInitReady = false;
    echInitPromise = null;
  } catch {}
}

export async function hasManualOverride() {
  try { return (await AsyncStorage.getItem(MANUAL_KEY)) === '1'; }
  catch { return false; }
}

export async function clearManualOverride() {
  try { await AsyncStorage.removeItem(MANUAL_KEY); } catch {}
}

export async function getJarInfo() {
  const mod = NativeModules.EchProxy;
  if (mod && typeof mod.jarInfo === 'function') {
    try { return await mod.jarInfo(); } catch { return '(jarInfo failed)'; }
  }
  return '(no jarInfo)';
}

export async function getConfigDomain() {
  try { return (await AsyncStorage.getItem(CONFIG_DOMAIN_KEY)) ?? DEFAULT_CONFIG_DOMAIN; }
  catch { return DEFAULT_CONFIG_DOMAIN; }
}

export async function setConfigDomain(domain) {
  try { await AsyncStorage.setItem(CONFIG_DOMAIN_KEY, domain); } catch {}
}

export function parseRemoteConfig(txt) { return null; }
export async function fetchRemoteConfig(domain) { return null; }

const echKy = ky.create({
  timeout: 30000,
  credentials: 'omit',
  fetch: async (input, init = {}) => echFetch(input, init),
  hooks: {
    afterResponse: [
      async (request, options, response) => {
        try {
          const url = new URL(request.url);
          console.log(`[ECH] ← ${response.status} ${url.hostname}${url.pathname}`);
        } catch {}
        return response;
      },
    ],
    beforeError: [
      async (error) => {
        if (error?.response?.status === 403) {
          try {
            const body = await error.response.clone().text();
            const head = body.slice(0, 500);
            const marker = /challenge-platform|_cf_chl_opt/i.test(head) ? 'CF_CHALLENGE'
              : /cf-error-details|cf-ray/i.test(head) ? 'CF_ERROR_PAGE' : 'PLAIN';
            console.log(`[ECH] 403 body (${body.length}b, ${marker}): ${head}`);
          } catch (e) {
            console.log(`[ECH] 403 but body unreadable: ${e?.message ?? e}`);
          }
        }
        return error;
      },
    ],
  },
});

export async function echSelfTest() {
  const doh = await getDoh();
  const ok = await ensureInit();
  if (!ok) {
    trackEvent('ech_self_test', { ok: false, reason: 'engine_unavailable' });
    const status = await getEchStatus();
    return `ECH engine unavailable.\nplatform: ${Platform.OS}\nreason: ${lastInitError ?? '(no recorded error)'}\nDoH: ${doh || '(none)'}\nnative status: ${status}`;
  }
  const t0 = Date.now();
  try {
    const res = await echKy.get('https://archiveofourown.org/', { timeout: 30000 });
    const ms = Date.now() - t0;
    const status = await getEchStatus();
    trackEvent('ech_self_test', { ok: true, ms, http: res.status, status: String(status).slice(0, 120) });
    return `OK — HTTP ${res.status} in ${ms}ms (in-process)\nDoH: ${doh || '(none)'}\n${status}`;
  } catch (e) {
    const ms = Date.now() - t0;
    const status = await getEchStatus();
    trackEvent('ech_self_test', { ok: false, ms, error: String(e?.message ?? e).slice(0, 120), status: String(status).slice(0, 120) });
    return `Request failed after ${ms}ms: ${e?.message ?? e}\nDoH: ${doh || '(none)'}\nStatus: ${status}`;
  }
}

initEch();

export default echKy;
