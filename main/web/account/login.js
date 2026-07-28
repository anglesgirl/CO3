import { fetchLoginAuthenticityToken } from './fetchAuthenticityToken';
import Toast from 'react-native-toast-message';
import {
  deleteCredsPasswd, hasStoredPassword,
  setCredsPasswd,
  setCredsToken,
  setLastLogin,
  setUsernameOnly,
} from '../../storage/Credentials';
import { navigationRef } from '../../app';
import i18n from 'i18next';
import CookieManager from '@react-native-cookies/cookies';
import getUrl, { postForm } from '../requestManager';
import { isLoggedInPage, withTimeout } from './session';

export const handleLogin = async (username, password) => {
  const t = i18n.t;

  if (!username || !password) {
    throw 'Please enter both username and password';
  }

  try {
    const sessionToken = await login(username, password);

    if (sessionToken) {
      await setCredsToken(sessionToken);

      if (await hasStoredPassword()) {
        await setCredsToken(sessionToken);
      } else {
        await deleteCredsPasswd();
        await setUsernameOnly(username);
      }

      await setLastLogin();
      Toast.show({
        type: 'success',
        text1: t('general_success'),
        text2: t('screen_account_login_success'),
      })
    } else {
      throw t('screen_account_login_failed_invalid_server_error');
    }
  } catch (error) {
    console.error('Login error:', error);
    throw t('screen_account_login_failed_generic');
  }
};


export default async function login(username, password) {
  try {
    const loginUrl = 'https://archiveofourown.org/users/login';
    const html = await postForm(loginUrl, {
      authenticity_token: await fetchLoginAuthenticityToken(),
      'user[login]': username,
      'user[password]': password,
      'user[remember_me]': '1',
      commit: 'Log in',
    }, { Referer: loginUrl });

    if (!isLoggedInPage(html)) throw new Error('Wrong username or password');
    const cookies = await CookieManager.get('https://archiveofourown.org');
    const sessionToken = cookies?._otwarchive_session?.value;
    if (!sessionToken) throw new Error('Session cookie not found');
    return sessionToken;
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
}

//Ok so this methode to check if the cookie is valid is horrendous
//I swear the way this website is coded makes me want to kms
//Basically what we do here is provide a token to the website and say we are authenticated
//But if the token is invalid the website will strip some cookies
//We detect that to guess if the cookie is valid or not.
//And guess is a very important word in this sentence lmao.
export async function validateCookie(sessionToken) {
  try {
    if (!sessionToken) return false;
    const html = await withTimeout(getUrl('https://archiveofourown.org/'));
    return isLoggedInPage(html);
  } catch (error) {
    console.error('Error validating cookie:', error);
    return false;
  }
}
