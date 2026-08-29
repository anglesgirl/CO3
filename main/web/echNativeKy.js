// echNativeKy: drop-in replacement for echKy using Han1me native BoringSSL (no Go proxy)
// Uses NativeModules.EchNative.request directly, with same DoH + retry logic as Han1me

import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AO3_HOSTS = new Set(['archiveofourown.org', 'www.archiveofourown.org']);
export const DEFAULT_DOH = 'https://82sew1c85i.cloudflare-gateway.com/dns-query';
const DOH_KEY = 'ech_doh';

async function getDoh() {
  try { const v = await AsyncStorage.getItem(DOH_KEY); return v || DEFAULT_DOH; } catch { return DEFAULT_DOH; }
}

async function buildHeaders(headers) {
  const out = [];
  if (headers) for (const [k,v] of Object.entries(headers)) out.push(`${k}: ${v}`);
  return out;
}

export async function echFetch(url, options = {}) {
  const { hostname } = new URL(url);
  if (!AO3_HOSTS.has(hostname) || Platform.OS !== 'android') {
    return fetch(url, options);
  }
  const mod = NativeModules.EchNative;
  if (!mod || !mod.request) return fetch(url, options);
  try {
    // init once
    if (mod.init) await mod.init().catch(()=>{});
    const method = (options.method || 'GET').toUpperCase();
    const headers = await buildHeaders(options.headers);
    const body = options.body ? Buffer.from(options.body).toString('base64') : null;
    const dohUrl = await getDoh();
    const dohResolve = '82sew1c85i.cloudflare-gateway.com:443:162.159.36.20,162.159.36.5';
    // retry once on ECH failure (Han1me logic)
    for (let attempt=0; attempt<2; attempt++) {
      try {
        const jsonStr = await mod.request(url, method, headers, body, dohUrl, dohResolve);
        const j = JSON.parse(jsonStr);
        const status = j.statusCode || 200;
        const bodyBytes = j.body ? Buffer.from(j.body, 'base64') : Buffer.alloc(0);
        const hdrs = {};
        if (j.headers) for (const h of j.headers) {
          const i = h.indexOf('\t'); if (i>0) hdrs[h.slice(0,i).toLowerCase()] = h.slice(i+1);
        }
        return new Response(bodyBytes, { status, headers: hdrs });
      } catch (e) {
        const isEch = String(e.message||e).includes('ECH');
        if (!isEch || attempt===1) throw e;
        await new Promise(r=>setTimeout(r,300));
      }
    }
  } catch (e) {
    console.warn('[ECH native] fallback', e.message);
  }
  return fetch(url, options);
}

export default echFetch;
