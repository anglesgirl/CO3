// echKy: a drop-in `ky` instance that routes archiveofourown.org traffic through
// the in-process ech_http engine (native module `EchHttp`). Both platforms.
//
// The proxy listens on http://127.0.0.1:<port> and re-originates each request to
// https://archiveofourown.org over a TLS handshake whose SNI is hidden with ECH.
// On Android, protected requests must not fall back to the system resolver.

import ky from 'ky';
import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isEchProtectedUrl } from './WebviewFetcher';
import { trackEvent } from '../utils/analytics';

const AO3_HOSTS = new Set(['archiveofourown.org', 'www.archiveofourown.org']);

// Default DoH endpoint (JSON API) used to fetch AO3's current ech= record.
// A reachable DoH is important behind the GFW — dns.google is usually blocked,
// which is why the default is a Cloudflare Gateway endpoint. User-overridable.
// AO3 请求必须带 User-Agent：CF 会直接 403 掉空 UA 的请求（引擎自检曾经
// 就是因此显示 403，而不是引擎有问题）。
// 真机 Chrome 的移动版 UA（用户实测取值），不含 WebView 自带的 "wv" 标记。
// **必须与原生侧 CoWebViewHelper.AO3_UA 一致** —— 同一域名的两条链路
// （JS 引擎请求 / WebView 子请求），UA 不一致会让 CF 风控看到两个"客户端"。
export const AO3_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/152.0.0.0 Mobile Safari/537.36';

export const DEFAULT_DOH = 'https://pieqllv9i7.cloudflare-gateway.com/dns-query';
export const DEFAULT_DOH_FALLBACKS = [
  DEFAULT_DOH,
  'https://m2b4x7vw98.cloudflare-gateway.com/dns-query',
  'https://dz1598pphb.cloudflare-gateway.com/dns-query',
];

// 内置优先 IP 默认值（默认留空，理由见下）。
//
// 历史上这两个值由远端 TXT 配置（ech-config.anglesgirl.eu.org 的 ip=）下发；
// 远端为冷启动提速被移除后，读取端 IP_KEY 就再没人写入，导致 hasIp 恒为 false。
//
// 中间曾在此填死网关 IP（先 162.159.36.x，后改 172.64.229.x）——
// 2026-09-22 用户拨测确认两组 IP 在国内**都是通的**：那条 21 秒超时不是 IP 不通，
// 而是「网关域名解析被污染」（连到了假地址）。所以这不该靠换硬编码 IP 来修。

// ⚠️ 默认**留空**（用户可在设置页手配）—— 这是用户定的方案：
//   · 网关地址由原生侧用国内种子 DoH 动态解析（go: gatewayIPsForDial → 国内三家纯 IP），
//     又快又好、免疫污染；而且网关可换：改 DoH 端点即可，不用动代码。
//   · 这里若填 Gateway 段 IP，它们会作为 ipList 落到原生 customIPs，而 customIPs
//     是用来连**目标域名**的。2026-08-15 实测：Gateway 段 IP 连 AO3 会触发
//     CF 1034 (Edge IP Restricted)，同一天用目标域官方段 IP 稳定 200。
//     所以默认不给，让目标域名走它自己的官方段。
export const DEFAULT_EDGE_IPS = '';

// Domain whose TXT record carries remote settings, so end users can pull a
// working DoH endpoint / edge IPs with one tap instead of understanding DoH.
// Publish a TXT record on this name, e.g.:
//   v=co3ech1; doh=https://example.com/dns-query; ip=104.20.8.2,104.20.9.2
// 注意：这个模块的真实导出名是 rlog（不是 remoteLog）—— import 名写错会导致启动即崩
import { rlog } from '../utils/remoteLog';

// Set this to your own domain before shipping builds.

const DOH_KEY = 'ech_doh';
const DOH2_KEY = 'ech_doh2';
const DOH3_KEY = 'ech_doh3';
const IP_KEY = 'ech_ip';
// Set once the user edits DoH/IP by hand — remote config must not clobber that.
// Last remote values we applied, so we only restart when they actually change.

// Returns the configured DoH endpoint. Unset -> default. Empty string means the
// user explicitly disabled DoH (proxy will use its baked-in config + retry_configs).
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

export async function getDohCandidates() {
  const values = await Promise.all(
    [DOH_KEY, DOH2_KEY, DOH3_KEY].map(key => AsyncStorage.getItem(key)),
  );
  const retired = 'https://0kbpekmcr1.cloudflare-gateway.com/dns-query';
  return [...new Set(
    [...DEFAULT_DOH_FALLBACKS, ...values].filter(value => value !== retired && isValidDoh(value)),
  )];
}

// Optional comma-separated list of preferred Cloudflare edge IPs.
// Custom IPs only change which edge we connect to; SNI/ECH stay the same.
// 用户在设置页手配的优先；未配置时用 DEFAULT_EDGE_IPS（现为空 = 不指定）。
// 空串现在是安全的：原生侧用国内种子 DoH 解析网关地址，解析不出来还有内置快照兜底，
// 不会退化成走系统 DNS（那条路会被污染，实测卡 21 秒后 fail-closed）。
export async function getCustomIPs() {
  try {
    const v = await AsyncStorage.getItem(IP_KEY);
    if (v && v.trim()) return v.trim();
    return DEFAULT_EDGE_IPS;
  } catch {
    return DEFAULT_EDGE_IPS;
  }
}

// Go 本地代理已从两端移除（Android 与 iOS 都由进程内 ech_http 引擎承担）。
// 保留 getLastStartError 供诊断页复用 —— 现在不存在"代理启动失败"这回事。
const lastStartError = null;

export function getLastStartError() {
  return lastStartError;
}

export function getEchBase() {
  // 引擎不监听端口，没有本地代理地址。'engine' 是"就绪"标记，
  // 调用方据此判断可用，而不是去拼 URL。
  return Promise.resolve('engine');
}

// Eagerly warm up the proxy so it's ready before the first AO3 request.
export function initEch() {
  rlog('startup_env', {
    platform: Platform.OS,
    osVersion: String(Platform.Version ?? ''),
    dohDefault: DEFAULT_DOH,
  });
  pushDohConfigToNative();
  // 只在没有进行中的启动时才触发，避免 App 启动瞬间多处 import 同时
  // 调用造成并发请求（引擎侧会返回已经在处理，
  // JS 侧则丢掉端口 → 之后 30s 冷却里全部请求 fail-closed。
  // 2026-08-11 iOS 真机日志实测到这个竞态）。
  // Android：请求全部走 ech_http 引擎，不再启动本地 Go 代理（引擎不监听端口，
  // 也没有「代理没起来 / 配置没生效」这一整类问题）。只把 DoH 配置推给原生。
  if (engineAvailable()) return;
  if (echBasePromise) return;
  // 2026-08-15 App 启动即预热 ECH（用户要求：不等用户操作）：
  // 代理启动只是监听端口，DoH 解析/ECH 配置获取/TLS 握手是首个真实
  // 请求时才做（移动宽带上首次可卡 30s+，用户日志实证）。这里启动
  // 代理后立即后台预请求 AO3 主页，把整条链路（transportFor 的 DoH
  // 解析 + ECH 配置 + 连接池）全部热起来 —— 用户点浏览时直接秒出。
  const warm = async () => {
    try {
      await getEchBase();
      const t0 = Date.now();
      try {
        await echKy.get('https://archiveofourown.org/', { timeout: 20000 }).text();
        console.log(`[ECH] warm-up complete in ${Date.now() - t0}ms`);
      } catch (e) {
        // 预热失败不阻塞：真实请求仍会正常走（只是慢一次）
        console.log(`[ECH] warm-up request failed in ${Date.now() - t0}ms: ${e?.message ?? e}`);
      }
    } catch {}
  };
  warm();
}

// 引擎路线（ech_http）专用：把 DoH 端点/优选 IP 交给原生一份。
//
// 为什么需要：ech_http 引擎自己不查 DoH —— 它只接受 echConfig + connectIp 两个
// 参数，都要调用方准备好；而 DoH 端点的权威在 JS（AsyncStorage），原生读不到。
// WebView 的拦截路径（CoWebViewHelper）因此需要这份落盘配置，否则整条引擎链路
// 只能 fail-closed。失败不抛：只影响引擎路径，旧链路照旧。
async function pushDohConfigToNative() {
  try {
    const mod = NativeModules.EchHttp;
    if (!mod || typeof mod.setDohConfig !== 'function') return;
    const doh = (await getDohCandidates()).join(',');
    const ips = await getCustomIPs();
    // configHost 留空：AO3 自己就发 ECH 记录，不需要借用别的域名。
    await mod.setDohConfig(doh, '', ips ?? '');
  } catch (e) {
    console.warn('[ECH] push doh config to native failed:', e?.message ?? e);
  }
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

// ⚠️ 远程 TXT 下发已**永久移除**（用户明确要求，**勿加回**）：不要重新引入
// 「启动时从运营方域名拉 TXT / JSON 下发 DoH、优选 IP、翻译端点」这类逻辑。
// 需要改配置时一律走 app 内设置项（setDoh / setCustomIPs，写入本地存储）。

// ---- 引擎 fetch（Android） ----
//
// ech_http 引擎不监听端口，所以没有「把 URL 改写成 127.0.0.1:<port>」这一步了：
// 直接把原始 https URL 交给原生引擎，TLS + ECH 在同一进程内完成。cookie 由原生
// CookieManager 读写（引擎零 cookie 代码），这里不传也不收 cookie。

// 把引擎返回的「纯文本响应头」包装成 fetch Response 需要的最小 headers 接口。
function engineHeaders(raw) {
  const map = new Map();
  String(raw || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const i = line.indexOf(':');
      if (i <= 0) return;
      const name = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      if (name === 'set-cookie') {
        // 同名多值（多条 Set-Cookie）不能互相覆盖：AO3 登录的 session 与
        // user_credentials 是分多条下发的，只留最后一条会丢关键 cookie。
        // 用 \n 拼接，读取侧按行拆分。
        map.set(name, map.has(name) ? `${map.get(name)}\n${value}` : value);
      } else {
        map.set(name, value);
      }
    });
  return {
    get: (name) => map.get(String(name).toLowerCase()) ?? null,
    has: (name) => map.has(String(name).toLowerCase()),
    forEach: (fn) => map.forEach((v, k) => fn(v, k)),
    entries: () => map.entries(),
  };
}

// 走引擎的一次请求，返回 fetch 兼容的响应对象（ky 只用到这几个字段）。
//
// 入参是 **Request 对象** —— ky 内部是 `fetch(request, nonRequestOptions)`
// （见 ky 源码 core/Ky.ts），所以必须从它身上取 url/method/headers/body。
// 早期实现用 `String(input)` 兜底，得到的是 "[object Request]"：域名判定随之
// 失效、请求被误判成"非保护域"原样交给原生 fetch → 明文出网（真机表现就是
// 快速自检 4ms「Network request failed」）。
async function echEngineFetch(req) {
  const mod = NativeModules.EchHttp;
  if (!mod || typeof mod.request !== 'function') {
    throw new Error('ECH engine unavailable; refusing direct HTTPS request');
  }
  const doh = (await getDohCandidates()).join(',');
  const ips = (await getCustomIPs()) ?? '';

  let hasUA = false;
  const headerLines = [];
  req.headers.forEach((v, k) => {
    const name = String(k).toLowerCase();
    // cookie 由原生 CookieManager 注入，避免两处各带一份
    if (name === 'cookie') return;
    if (name === 'user-agent') hasUA = true;
    headerLines.push(`${k}: ${v}`);
  });
  // AO3 对空 UA 直接 403（引擎自检曾经就是因此报 403）。调用方没带就补上。
  if (!hasUA) headerLines.push(`User-Agent: ${AO3_UA}`);

  // 补齐"浏览器会带"的头 —— 这不是锦上添花，是能不能通的开关。
  // 实测（同一 IP、同一路径 /works，只换请求头）：
  //     只有 User-Agent                   → 525
  //     +Accept                           → 525
  //     +Accept-Language +Accept-Encoding → 200   ← 决定性
  //     +Sec-Fetch 全套                   → 200
  // Cloudflare 把"头不齐全"的请求当非浏览器流量挑战，直接回 525；
  // 浏览器发齐全的头所以正常。缺了这几个头，请求必然 525。
  const seen = new Set(
    headerLines.map((l) => l.slice(0, l.indexOf(':')).trim().toLowerCase()),
  );
  const BROWSER_DEFAULTS = [
    ['accept', 'Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
    ['accept-language', 'Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8'],
    // 引擎自带解压（curl auto_uncompress），所以这里可以安全地声明 gzip。
    ['accept-encoding', 'Accept-Encoding', 'gzip, deflate'],
    ['upgrade-insecure-requests', 'Upgrade-Insecure-Requests', '1'],
    ['sec-fetch-dest', 'Sec-Fetch-Dest', 'document'],
    ['sec-fetch-mode', 'Sec-Fetch-Mode', 'navigate'],
    ['sec-fetch-site', 'Sec-Fetch-Site', 'same-origin'],
    ['sec-fetch-user', 'Sec-Fetch-User', '?1'],
  ];
  for (const [lower, name, value] of BROWSER_DEFAULTS) {
    if (!seen.has(lower)) headerLines.push(`${name}: ${value}`);
  }

  let body = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Request 的 body 是流，只能读一次；clone 后再读，避免影响原对象。
    try {
      body = await req.clone().text();
    } catch (_) {
      body = '';
    }
  }

  // 5xx 重试。525 是 Cloudflare 报的"连不上 AO3 源站"，间歇性极强 ——
  // 真机日志里同一分钟既有 200 也有 525。这条路径此前一次失败就直接抛，
  // 而 WebView 那条是有重试的，所以表现为"页面能开、接口全挂"。
  const RETRYABLE = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);
  // 3xx 跟随重定向：引擎 FOLLOWLOCATION=0 不自动跳，而 AO3 的登录跳转、
  // view_adult 确认跳转都是 302（真机日志统一判成 "Request failed with status
  // code 302"）。WebView 拦截路径对 3xx 是包装 200 透传 Location 由 WebView 跟，
  // JS 路径直接跟到最终响应 —— 两条路径行为一致（"与 WebView 完全同构"）。
  const MAX_REDIRECTS = 5;
  let res = null;
  let lastErr = null;
  let currentUrl = req.url;
  for (let redirect = 0; redirect < MAX_REDIRECTS; redirect += 1) {
    let attemptRes = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const r = await mod.request(
          currentUrl,
          req.method,
          headerLines.join('\r\n'),
          body,
          doh,
          ips,
          '',      // configHost：AO3 自己发 ECH 记录，不借用
          30000,
        );
        if (r && RETRYABLE.has(r.status)) {
          lastErr = new Error(
            `Request failed with status code ${r.status}: ${req.method} ${currentUrl}`,
          );
          await new Promise((done) => setTimeout(done, 700 * (attempt + 1)));
          continue;
        }
        attemptRes = r;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((done) => setTimeout(done, 700 * (attempt + 1)));
      }
    }
    if (!attemptRes) {
      res = null;
      break;
    }
    if (attemptRes.status >= 300 && attemptRes.status < 400) {
      const loc = engineHeaders(attemptRes.headers).get('location');
      if (!loc) {
        // 无 Location 的 3xx：返回原样（真实状态码由调用方读取）。
        res = attemptRes;
        break;
      }
      currentUrl = new URL(loc, currentUrl).toString();
      lastErr = null;
      continue;
    }
    res = attemptRes;
    break;
  }
  if (!res) throw lastErr ?? new Error('ECH engine request failed');
  const text = res.body ?? '';
  return {
    ok: res.status >= 200 && res.status < 400,
    status: res.status,
    statusText: '',
    url: currentUrl,
    headers: engineHeaders(res.headers),
    text: async () => text,
    json: async () => JSON.parse(text),
    clone() {
      return this;
    },
  };
}

// 引擎是否可用。**Android 与 iOS 共用同一条引擎路线**（ech_http 全平台支持），
// 不再存在"某个平台走 Go 本地代理"的分支。
function engineAvailable() {
  const mod = NativeModules.EchHttp;
  return !!mod && typeof mod.request === 'function';
}

// echFetch sends a request for ANY HTTPS host; ECH applies when the target
// qualifies. Android → ech_http 引擎；iOS → 本地 Go 代理（原样保留）。
// 引擎/代理都不可用时对 https 直接抛错（fail-closed）。
export async function echFetch(input, init = {}) {
  // ky 传进来的是 Request 对象（ky 源码：`fetch(request, nonRequestOptions)`），
  // 这里统一规范化，之后一律用 req.url 取域名。**不能 String(input)** ——
  // 那会得到 "[object Request]"，域名判定失效后请求会被当"非保护域"直连明文。
  let req;
  try {
    req = input instanceof Request ? input : new Request(input, init);
  } catch (e) {
    throw new Error(`ECH: 无法规范化请求（${String((e && e.message) || e)}）`);
  }
  const url = req.url;

  // 非保护域（站外图片、统计上报等）不接管：fail-closed 只针对受保护域，
  // 否则引擎一有问题连无关请求都会一起失败。
  if (!isEchProtectedUrl(url)) return fetch(input, init);

  if (engineAvailable()) return echEngineFetch(req);

  const base = await getEchBase();
  const u = new URL(url);
  if (!base || base === 'engine') {
    throw new Error('ECH proxy unavailable; refusing direct HTTPS request');
  }
  return fetch(base + u.pathname + u.search, {
    method: req.method,
    headers: req.headers,
    body: init.body ?? undefined,
    'X-Ech-Target': u.hostname,
  });
}

// Latest native handshake/status line (e.g. "... ECHAccepted=true ...").
export async function getEchStatus() {
  // Android：请求由 ech_http 引擎接管，状态来自引擎桥。
  if (engineAvailable()) {
    const ehttp = NativeModules.EchHttp;
    if (ehttp && typeof ehttp.status === 'function') {
      try {
        const s = await ehttp.status();
        return `引擎 ${s.version}（Android 已接管请求，无本地端口）`;
      } catch (e) {
        return `engine status error: ${e?.message ?? e}`;
      }
    }
  }
  // 引擎桥没注册时如实说明 —— 已不存在"退回 Go 本地代理"这条分支。
  return `unavailable: EchHttp 引擎桥未注册（当前注册 ${Object.keys(NativeModules || {}).length} 个原生模块）`;
}

// 配置变更不需要"重启代理"：引擎每次请求都实时读取原生那份 DoH。
async function restartProxy() {
  return 'engine';
}

// Clear all cookies held by the proxy's in-memory cookie jar. The jar is
// recreated on every Start(), so a restart both drops AO3 session cookies and
// picks up any fresh DoH/IP settings. Call this on logout so that a subsequent
// login request does not arrive still "already logged in" with the old cookie.
export async function clearAuthCookies() {
  // Android：cookie 权威在 CookieManager（引擎零 cookie 代码），登出=清它。
  if (engineAvailable()) {
    const mod = NativeModules.EchHttp;
    if (mod && typeof mod.clearCookies === 'function') return mod.clearCookies(false);
    return null;
  }
  await restartProxy();
}

// 只清除 AO3 会话 cookie(_otwarchive_session / user_credentials),保留
// cf_clearance。登录重试时 AO3 不再 302 到用户主页(否则 WebView 验证窗口
// 永不弹出),且不会作废用户刚完成的 Cloudflare 验证 —— 重启代理会连
// cf_clearance 一起丢,导致无限 challenge 循环。
export async function clearSessionCookies() {
  // Android：cookie 权威在 CookieManager。keepCf=true 保留 cf_clearance / __cf_bm /
  // _cfuvid，只清 session —— 清掉 CF 验证会陷入无限 challenge 循环。
  if (engineAvailable()) {
    const ehttp = NativeModules.EchHttp;
    if (ehttp && typeof ehttp.clearCookies === 'function') return ehttp.clearCookies(true);
    return null;
  }
  // 引擎桥不可用：如实返回 null，不假装清成功（调用方据返回值判断）。
  return null;
}

// Change the DoH endpoint and restart the proxy with it. Pass '' to disable DoH.
// `manual` marks it as a user edit, which stops remote config from overriding it.
export async function setDoh(doh, manual = true) {
  await AsyncStorage.setItem(DOH_KEY, doh ?? '');
  await pushDohConfigToNative(); // 引擎路线：原生那份也要跟着更新
  return restartProxy();
}

// Set preferred edge IPs (comma-separated) and restart. Pass '' to use DNS.
export async function setCustomIPs(ips, manual = true) {
  await AsyncStorage.setItem(IP_KEY, ips ?? '');
  await pushDohConfigToNative(); // 引擎路线：原生那份也要跟着更新
  return restartProxy();
}

// Whether the user has hand-edited the DoH/IP settings.

// Clear the manual flag so remote config takes over again.

// 读取代理 cookiejar 的完整内容(文本)。交互式登录窗口用它轮询
// 检测登录是否成功(_otwarchive_session 出现在清空后的 jar 里)。
export async function getJarInfo() {
  // Android：没有 Go jar 了，cookie 全在 CookieManager（只报名字与长度，不含值）。
  if (engineAvailable()) {
    const ehttp = NativeModules.EchHttp;
    if (ehttp && typeof ehttp.cookieSummary === 'function') {
      try {
        const s = await ehttp.cookieSummary();
        return (
          `CookieManager(AO3): ${s.count} 条` +
          ` hasSession=${s.hasSession} hasCreds=${s.hasCreds}\n` +
          `  ${s.names}`
        );
      } catch (e) {
        return `cookieSummary 失败: ${e?.message ?? e}`;
      }
    }
  }
  return null;
}




// Parses a TXT payload like:
//   v=co3ech1; doh=https://example.com/dns-query; ip=104.20.8.2,104.20.9.2
// Returns { doh, ip } with whatever keys were present.

// Fetches the remote config TXT record. Uses the currently configured DoH (or
// the built-in default) for the lookup, so it works even with poisoned DNS.

const echKy = ky.create({
  // 请求转发全部交给 echFetch：两端都走进程内 ech_http 引擎（原始 https URL +
  // 进程内 ECH），没有本地端口。原来那个把 URL 改写成 127.0.0.1 的
  // beforeRequest hook 已删除 —— 引擎不监听端口，改写反而会绕过 ECH。
  // 不要 String(input)：ky 传的是 Request 对象，String() 会得到
  // "[object Request]" 从而绕过域名判定。echFetch 内部自行规范化。
  fetch: (input, init) => echFetch(input, init || {}),
  // Generous timeout: the first request may have to bootstrap the ECH handshake.
  // 45000 > 引擎预算(30000)：让引擎先到期 reject（错误信息带候选 IP），
  // 而不是被 ky 的 30s 超时掩盖成笼统的 "Request timed out"。
  timeout: 45000,
  // AO3 的 session cookie 只有一份权威来源：原生 CookieManager。引擎零 cookie
  // 代码，cookie 由 shouldInterceptRequest / 引擎请求两侧统一交给它保管。
  // credentials:'omit' 让 RN fetch 层不去掺一脚，避免出现第二份 cookie。
  credentials: 'omit',
  hooks: {
    // beforeRequest 的 URL 改写已删除：转发逻辑统一在 echFetch（Android 引擎 /
    // iOS 本地代理）。留着它会继续把 URL 改写成 127.0.0.1 —— 而引擎不监听端口，
    // 那等于绕开 ECH。
    afterResponse: [
      async (request, options, response) => {
        const url = new URL(request.url);
        console.log(`[ECH] ← ${response.status} ${url.hostname}${url.pathname}`);
        return response;
      },
    ],
    beforeError: [
      // 403 诊断：打印响应体前 500 字符，区分 CF challenge / 错误页 / 其他。
      // 2026-08-15 UA 修复后仍 403 —— 需要响应体才能定位拦截类型。
      async (error) => {
        if (error?.response?.status === 403) {
          try {
            const body = await error.response.clone().text();
            const head = body.slice(0, 500);
            const marker = /challenge-platform|_cf_chl_opt/i.test(head)
              ? 'CF_CHALLENGE'
              : /cf-error-details|cf-ray/i.test(head)
                ? 'CF_ERROR_PAGE'
                : 'PLAIN';
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

// echSelfTest forces a request through the ECH proxy to archiveofourown.org and
// returns a human-readable result including the native handshake line
// (look for "ECHAccepted=true"). Used by the Debug screen.
export async function echSelfTest() {
  const doh = await getDoh();
  const base = await getEchBase();
  if (!base) {
    // 把真正的原因带出来：桥没注册 / start() 报错 / 冷却中。
    const status = await getEchStatus();
    trackEvent('ech_self_test', { ok: false, reason: 'proxy_unavailable' });
    return (
      `ECH proxy unavailable.\n` +
      `platform: ${Platform.OS}\n` +
      `reason: ${lastStartError ?? '(no recorded error — proxy may not have been started yet)'}\n` +
      `DoH: ${doh || '(none)'}\n` +
      `native status: ${status}`
    );
  }
  const t0 = Date.now();
  try {
    const res = await echKy.get('https://archiveofourown.org/', {
      timeout: 30000,
      headers: { 'User-Agent': AO3_UA },
    });
    const ms = Date.now() - t0;
    const status = await getEchStatus();
    trackEvent('ech_self_test', { ok: true, ms, http: res.status });
    return `OK — HTTP ${res.status} in ${ms}ms via ${base}\nDoH: ${doh || '(none)'}\n${status}`;
  } catch (e) {
    const ms = Date.now() - t0;
    const status = await getEchStatus();
    trackEvent('ech_self_test', {
      ok: false,
      ms,
      error: String(e?.message ?? e).slice(0, 120),
    });
    return `Request failed after ${ms}ms: ${e?.message ?? e}\nDoH: ${doh || '(none)'}\nStatus: ${status}`;
  }
}

// Warm up the proxy as soon as this module is imported (app startup).
initEch();

export default echKy;
