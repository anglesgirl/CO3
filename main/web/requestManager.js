import kyDefault, { TimeoutError } from 'ky';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchViaWebView, isEchProtectedUrl } from './WebviewFetcher';
import { Platform } from 'react-native';
import { diagEvent } from '../utils/diag';

/**
 * ECH 传输层在两端是**不同实现** —— 这是刻意的设计取舍，不是历史遗留：
 *
 *  · **Android**：OkHttp + Conscrypt，进程内拦截器（Kotlin）。用普通 ky 即可，
 *    拦截器自动给 AO3 流量套上 ECH（无外挂线程、无本地端口）。
 *  · **iOS**：Conscrypt 是 Java 库，iOS 上根本不存在。因此走 **Go 代理**
 *    —— gomobile 打出的 `Echproxy.xcframework` + 本地 pod `EchProxyBridge`，
 *    由 `echKy` 这个 drop-in ky 实例把 AO3 请求重写到本地代理。
 *
 * 两者在 JS 层是**同一套 ky 接口**，业务代码完全无感 —— 两端的差异只存在于
 * 传输层这一个位置，其余（UI/登录/翻译/书签/排队…）全部共享同一份代码。
 *
 * ⚠️ **超时必须两端一致（30 秒）。** 此前 Android 用的是 ky 默认 10 秒，
 * 而 iOS 的 `echKy` 明确给了 30 秒（其注释原文：the first request may have to
 * bootstrap the ECH handshake），两端差 3 倍。
 *
 * 实测后果（2026-09-23 用户反馈「点三次才加载出文章」）：
 * 冷启动首次请求要依次完成 DoH 解析（日志实测 boot.prewarm.dns ms=3079）、
 * 取 ECH 配置、TLS 握手 —— 10 秒不够就超时，超时又触发那条必然失败的回退，
 * 于是用户在界面上看到「ECH 失败」。给足 30 秒后，第一次就能成功。
 */
const ky = Platform.OS === 'ios'
  ? require('./echKy').default
  : kyDefault.create({ timeout: 30000 });
import {
  deleteCredsPasswd,
  deleteCredsToken,
  deleteLastLogin,
  getCredsPasswd,
  getLastLogin,
  getUsername,
  hasStoredPassword,
} from '../storage/Credentials';
import Toast from 'react-native-toast-message';
import { navigationRef } from '../app';
import { handleLogin } from './account/login';

const CF_STORAGE_KEY = 'cf_domains';
const CF_MODE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function getCFMap() {
  const raw = await AsyncStorage.getItem(CF_STORAGE_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function isCFMode(domain) {
  // fail-closed：ECH 保护域名一律不认 CF(WebView) 模式 —— 即使 AsyncStorage
  // 里已经存有历史记录（早前版本写入的），也按"未启用"处理，
  // 避免设备上残留的标记导致后续请求持续走 WebView 泄漏 SNI。
  if (isEchProtectedUrl(`https://${domain}`)) return false;
  const map = await getCFMap();
  if (!map[domain]) return false;
  if (Date.now() > map[domain]) {
    delete map[domain];
    await AsyncStorage.setItem(CF_STORAGE_KEY, JSON.stringify(map));
    return false;
  }
  return true;
}

async function enableCFMode(domain) {
  // fail-closed：ECH 保护域名**绝不**切到 WebView(CF) 模式。
  // 该模式会让 WebView 明文直连（SNI 暴露给 GFW），而且会被持久化到
  // AsyncStorage —— 一旦写入，后续所有请求都会持续走 WebView 泄漏 SNI。
  if (isEchProtectedUrl(`https://${domain}`)) {
    console.warn(`[CO3-ECH] fail-closed: 拒绝对 ${domain} 启用 CF/WebView 模式`);
    return;
  }
  const map = await getCFMap();
  map[domain] = Date.now() + CF_MODE_DURATION;
  await AsyncStorage.setItem(CF_STORAGE_KEY, JSON.stringify(map));
}

function isCFChallenge(html) {
  return html.includes('_cf_chl_opt');
}

const cloudflareErrorCodes = [
  403, //Unauthorized
  525, //Supposed to be an SSL error but CF uses it to block automated request sometimes
  418, //Don't ask me why, I did have an encounter with CF and this error code using tor exit nodes
  520, //CF specific, "Unknown error"
  522, //CF specific, "Connection Timed Out"
  503, //Used for CF challenges
]

export default async function getUrl(url, noWebview = false) {
  const { hostname } = new URL(url);

  if (noWebview) {
    getLastLogin().then(async (time) => {
      try {
        if (Date.now() - time > 14 * 24 * 60 * 60 * 1000) {
          Toast.show(
            {
              type: 'error',
              text1: "You have been logged out !",
              text2: "It's been two week since you last logged in.",
              onPress: async () => {
                if (await hasStoredPassword()) {
                  try {
                    await handleLogin(await getUsername(), await getCredsPasswd());
                  } catch (e) {
                    Toast.show({
                      type: 'error',
                      text1: "Login failed.",
                      text2: e,
                      onPress: () => {
                        navigationRef.navigate("Account", {});
                      }
                    })

                    deleteLastLogin();
                    deleteCredsPasswd();
                    deleteCredsToken();
                  }
                } else {
                  navigationRef.navigate("Account", {});
                }
              }
            }
          )

          if (!await hasStoredPassword()) {
            deleteLastLogin();
            deleteCredsPasswd();
            deleteCredsToken();
          }
        }
      } catch (error) {
        console.error(error);
      }
    })
  }

  if (!(Platform.OS === 'ios' || Platform.OS === 'android')) {
    noWebview = true;
  }

  if (!noWebview && await isCFMode(hostname)) {
    console.log(`using webview to fetch ${url}`);
    return fetchViaWebView(url);
  }

  try {
    const html = await ky.get(url).text();

    if (isCFChallenge(html)) {
      console.log(`isCfChalenged fiered with ${html}`);
      return await fallbackOrSurfaced(url, hostname, 'cf_challenge');
    }

    console.log(`fetched ${url} via ky.`);
    return html;
  } catch (err) {
    if (cloudflareErrorCodes.includes(err?.response?.status)) {
      return await fallbackOrSurfaced(url, hostname, `http_${err.response.status}`);
    }
    if (err instanceof TimeoutError) {
      return await fallbackOrSurfaced(url, hostname, 'timeout');
    }
    diagEvent('ech_fetch_fail', {
      url: url.slice(0, 90),
      host: hostname,
      why: 'other',
      err: String(err && (err.message || err.name)).slice(0, 120),
    });
    throw err;
  }
}

/**
 * ky（ECH 栈）失败后的处理。
 *
 * ⚠️ **受 ECH 保护的域名绝不能回退到 WebView。**
 *
 * 原因：`fetchViaWebView` 对 `ECH_PROTECTED_HOSTS` 里的域名是**直接 fail-closed 拒绝**的
 * （见 WebviewFetcher：标准 WebView 没有 shouldInterceptRequest，直连会明文暴露 SNI）。
 * 所以那条回退不是「兜底」，是**保证失败** ——
 * 它把「一个慢但能成功的请求」变成「立刻弹出 ECH 失败」。
 *
 * 实测症状（2026-09-23 用户反馈，三次才成功）：
 *   第 1 次 ky 超时 → 回退 WebView → 立即 ECH_FAIL_CLOSED → 提示「ECH 失败」
 *   第 2 次 ky 又失败 → 同上
 *   第 3 次 ky 成功 → 文章出来
 * 而日志里一条失败记录都没有 —— 因为这是纯 JS 的本地拒绝，根本不经过网络。
 *
 * 现在的行为：如实上报真实原因（进远程日志）+ 抛出真实错误。
 * **不加重试** —— 用户定过铁律：对接第三方服务禁自动重试，一次操作一个请求。
 */
async function fallbackOrSurfaced(url, hostname, why) {
  if (isEchProtectedUrl(url)) {
    diagEvent('ech_fetch_fail', {
      url: url.slice(0, 90),
      host: hostname,
      why,
      protected: 'true',
      note: '受保护域，不回退 WebView（那条路必然失败）；如实抛出真实原因',
    });
    const err = new Error(`ECH 请求失败（${why}）`);
    err.name = 'EchFetchError';
    err.why = why;
    throw err;
  }
  // 非保护域：维持原有 WebView(CF) 回退行为不变
  diagEvent('cf_fallback', { host: hostname, why });
  await enableCFMode(hostname);
  return fetchViaWebView(url, { cfWarning: true });
}