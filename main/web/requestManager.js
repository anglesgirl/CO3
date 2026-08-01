import ky from './echKy';
import { TimeoutError } from 'ky';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchViaWebView } from './WebviewFetcher';
import { Platform } from 'react-native';
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
import {
  createNavigationContainerRef,
  useNavigation,
} from '@react-navigation/native';
import { navigationRef } from '../app';
import { handleLogin } from './account/login';
import i18n from '../storage/LanguageManager';

const CF_STORAGE_KEY = 'cf_domains';
const CF_MODE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function getCFMap() {
  const raw = await AsyncStorage.getItem(CF_STORAGE_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function isCFMode(domain) {
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

export default async function getUrl(url, noWebview = false, options = {}) {
  const { hostname } = new URL(url);

  if (noWebview) {
    getLastLogin().then(async (time) => {
      try {
        if (Date.now() - time > 14 * 24 * 60 * 60 * 1000) {
          Toast.show(
            {
              type: 'error',
              text1: i18n.t('screen_account_session_expired'),
              text2: i18n.t('screen_account_session_expired_sub'),
              onPress: async () => {
                if (await hasStoredPassword()) {
                  try {
                    // The saved credential may be an email, while getUsername()
                    // is the canonical AO3 profile name used for /users URLs.
                    // Re-login must use the original login identifier instead.
                    const savedCreds = await getCredsPasswd();
                    if (!savedCreds) throw new Error('Saved login is unavailable');
                    await handleLogin(savedCreds.username, savedCreds.password);
                  } catch (e) {
                    Toast.show({
                      type: 'error',
                      text1: i18n.t('screen_search_fetch_failed', {
                        resource: i18n.t('screen_search_resource_login'),
                      }),
                      text2: i18n.t('general_operation_failed'),
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

  // 即使 CF 模式开启，也先尝试 ECH 代理（ky），因为它更快且能绕墙。
  // 只有当 ky 返回 CF 挑战页面时才需要 WebView 来执行 JS 挑战。
  // 之前的逻辑是 CF 模式一开就完全跳过 ky 直走 WebView，导致 WebView
  // 裸连 archiveofourown.org 被 GFW 重置 (-6 ERR_CONNECTION_RESET)。
  const reqStart = Date.now();
  try {
    const html = await ky.get(url, options).text();
    console.log(`[NET] ${url} → ${html.length} chars in ${Date.now() - reqStart}ms (ECH)`);

    if (isCFChallenge(html)) {
      console.log(`[NET] CF challenge detected for ${url} after ${Date.now() - reqStart}ms`);
      await enableCFMode(hostname);
      return fetchViaWebView(url, { cfWarning: true });
    }

    return html;
  } catch (err) {
    const elapsed = Date.now() - reqStart;
    console.log(`[NET] ${url} FAILED in ${elapsed}ms: ${err?.message ?? err}`);

    // CF 挑战错误码：WebView 能解 JS 挑战，启用 CF 模式。
    if (cloudflareErrorCodes.includes(err?.response?.status)) {
      console.log(`[NET] CF error ${err?.response?.status}, trying WebView`);
      await enableCFMode(hostname);
      return fetchViaWebView(url, { cfWarning: true });
    }

    // 超时：不永久切换 CF 模式。ECH 握手首次可能慢，给它多一次机会。
    if (err instanceof TimeoutError) {
      console.log(`[NET] Timeout after ${elapsed}ms, retrying with 60s timeout...`);
      const retryStart = Date.now();
      try {
        const html = await ky.get(url, { ...options, timeout: 60000 }).text();
        console.log(`[NET] ${url} → ${html.length} chars in ${Date.now() - retryStart}ms (ECH retry)`);
        if (isCFChallenge(html)) {
          await enableCFMode(hostname);
          return fetchViaWebView(url, { cfWarning: true });
        }
        return html;
      } catch (retryErr) {
        console.log(`[NET] Retry also failed in ${Date.now() - retryStart}ms: ${retryErr?.message ?? retryErr}`);
        // 重试仍失败 → WebView 兜底（现在 WebView 也会走 ECH 代理）
        if (!noWebview) {
          console.log(`[NET] Falling back to WebView for ${url}`);
          return fetchViaWebView(url);
        }
        throw retryErr;
      }
    }

    // 其他网络错误：WebView 兜底（走 ECH），避免直接抛错影响体验。
    if (!noWebview) {
      console.log(`[NET] Trying WebView fallback for ${url}`);
      try {
        const wvStart = Date.now();
        const result = await fetchViaWebView(url);
        console.log(`[NET] WebView fallback OK in ${Date.now() - wvStart}ms`);
        return result;
      } catch (wvErr) {
        console.log(`[NET] WebView fallback also failed: ${wvErr?.message ?? wvErr}`);
        throw err; // WebView 也失败，抛原始错误
      }
    }

    throw err;
  }
}
