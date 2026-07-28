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
import {
  createNavigationContainerRef,
  useNavigation,
} from '@react-navigation/native';
import { navigationRef } from '../app';
import { handleLogin } from './account/login';

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

function shouldUseWebView(error) {
  return cloudflareErrorCodes.includes(error?.response?.status) ||
    error instanceof TimeoutError ||
    error?.name === 'TypeError';
}

export async function postForm(url, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  const request = {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
  };

  try {
    return await ky.post(url, { ...request, credentials: 'include' }).text();
  } catch (error) {
    if (!shouldUseWebView(error)) throw error;
    return fetchViaWebView(url, { cfWarning: true, request });
  }
}

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
      await enableCFMode(hostname);
      return fetchViaWebView(url, { cfWarning: true });
    }

    console.log(`fetched ${url} via ky.`);
    return html;
  } catch (err) {
    if (shouldUseWebView(err)) {
      await enableCFMode(hostname);
      return fetchViaWebView(url, { cfWarning: true });
    }
    throw err;
  }
}
