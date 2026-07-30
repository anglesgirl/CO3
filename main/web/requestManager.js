import ky, { ProtectedConnectionError } from './echKy';
import { TimeoutError } from 'ky';
import { fetchViaProtectedWebView } from './WebviewFetcher';
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

function isCFChallenge(html) {
  return [
    '_cf_chl_opt',
    'cdn-cgi/challenge-platform',
    'challenges.cloudflare.com',
  ].some(marker => html.includes(marker));
}

const cloudflareErrorCodes = [
  403, //Unauthorized
  525, //Supposed to be an SSL error but CF uses it to block automated request sometimes
  418, //Don't ask me why, I did have an encounter with CF and this error code using tor exit nodes
  520, //CF specific, "Unknown error"
  522, //CF specific, "Connection Timed Out"
  503, //Used for CF challenges
  429, //Rate limited; retry through ECH instead of switching transport
]

function protectedWebView(url, disabled) {
  if (disabled) {
    throw new ProtectedConnectionError('AO3 requires protected browser verification');
  }
  return fetchViaProtectedWebView(url, { cfWarning: true });
}

export default async function getUrl(url, noWebview = false) {
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

  try {
    const html = await ky.get(url).text();

    if (isCFChallenge(html)) {
      return protectedWebView(url, noWebview);
    }

    console.log(`fetched ${url} via ky.`);
    return html;
  } catch (err) {
    if (err instanceof ProtectedConnectionError) throw err;
    if (cloudflareErrorCodes.includes(err?.response?.status)) {
      return protectedWebView(url, noWebview);
    }
    if (err instanceof TimeoutError) {
      return protectedWebView(url, noWebview);
    }
    throw err;
  }
}
