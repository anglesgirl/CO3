import ky, { TimeoutError } from 'ky';
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
import { navigationRef } from '../app';
import { handleLogin } from './account/login';
import { syncSessionFromNative } from './syncSession';

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

export default async function getUrl(url, noWebview = false) {
  const { hostname } = new URL(url);

  if (noWebview) {
    // 先同步 WebView 的 HttpOnly session 到 Keychain，再做 14天判断（修复旧版官方登录丢失）
    syncSessionFromNative().catch(()=>{});
    getLastLogin().then(async (time) => {
      try {
        if (Date.now() - time > 14 * 24 * 60 * 60 * 1000) {
          Toast.show(
            {
              type: 'error',
              text1: "登录已过期（2周）",
              text2: "请到 账号中心 重新登录后再下载",
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
      await enableCFMode(hostname);
      return fetchViaWebView(url, { cfWarning: true });
    }

    console.log(`fetched ${url} via ky.`);
    return html;
  } catch (err) {
    if (cloudflareErrorCodes.includes(err?.response?.status)) {
      await enableCFMode(hostname);
      return fetchViaWebView(url, { cfWarning: true });
    }
    if (err instanceof TimeoutError) {
      await enableCFMode(hostname);
      return fetchViaWebView(url, { cfWarning: true });
    }
    throw err;
  }
}