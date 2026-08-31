import { fetchLoginAuthenticityToken } from './fetchAuthenticityToken';
import { syncSessionFromNative } from '../syncSession';
import { NativeModules } from 'react-native';
import Toast from 'react-native-toast-message';
import {
  deleteCredsPasswd,
  hasStoredPassword,
  setCredsToken,
  setLastLogin,
  setUsernameOnly,
} from '../../storage/Credentials';
import i18n from 'i18next';

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
      });
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
    // 必须用 urlencoded，不是 multipart（AO3 只认 application/x-www-form-urlencoded）
    const token = await fetchLoginAuthenticityToken();
    const params = new URLSearchParams();
    params.append('authenticity_token', token);
    params.append('user[login]', username);
    params.append('user[password]', password);
    params.append('user[remember_me]', '1');
    params.append('commit', 'Log in');

    // Send the login request
    const response = await fetch('https://archiveofourown.org/users/login?return_to=%2F', {
      method: 'POST',
      body: params.toString(),
      credentials: 'include', // Important for cookies
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        Referer: 'https://archiveofourown.org/users/login?return_to=%2F',
        Origin: 'https://archiveofourown.org',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        Priority: 'u=0, i',
      }, //Yea cloudflare was hard on this one, so i'm officially a web browser YaY
      //Like fr i'm a win 10 machine on chrome wdym
      //We just need to pray cloudflare will leave me alone
    });

    if (response.url === 'https://archiveofourown.org/users/login') {
      throw new Error('Wrong username or password');
    }

    // Extract the session cookie from the response headers
    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      // Look for the otwarchive session cookie
      const cookies = setCookieHeader.split(',');
      for (let cookie of cookies) {
        const trimmedCookie = cookie.trim();
        if (
          trimmedCookie.includes('otwarchive') &&
          trimmedCookie.includes('session=')
        ) {
          // Extract the session value
          const sessionMatch = trimmedCookie.match(/session=([^;]+)/);
          if (sessionMatch) {
            return sessionMatch[1]; // Return the session cookie value
          }
        }
      }
    }

    if (response.ok) {
      if (
        response.redirected ||
        response.url !== 'https://archiveofourown.org/users/login'
      ) {
        console.log(
          'Login appears successful but session cookie not found in headers',
        );
        return null;
      }
    }

    throw new Error(`Login failed: ${response.status} ${response.statusText}`);
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
/**
 * 登录状态验证：直接读 CookieManager 的 user_credentials（AO3 登录成功才下发该 cookie）。
 * WebView 登录成功后真实 cookie 就在本地，无需网络请求校验 HTML。
 */
export async function validateCookie(sessionToken) {
  try {
    const mod = NativeModules.CoCookieModule;
    if (mod && mod.hasUserCredentials) {
      const ok = await mod.hasUserCredentials();
      return !!ok;
    }
    // 兜底：原生模块不可用时退回旧逻辑
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const response = await fetch('https://archiveofourown.org/', {
      method: 'GET',
      credentials: 'include',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Cookie': `user_credentials=1; _otwarchive_session=${sessionToken}`
      }
    });
    clearTimeout(timer);
    const html = await response.text();
    if (response.url && response.url.includes('/users/login')) return false;
    if (html.includes('user[password]') || html.includes('user_password')) return false;
    if (response.status === 200 &&
        (html.includes('Log Out') || html.includes('log_out') || html.includes('logout'))) {
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error validating cookie:', error);
    return false;
  }
}

/**
 * 原生表单登录提交（账号中心用）。
 * 参考旧版（B0.0.20 能登录）的核心逻辑：登录成功 → URL 跳离 /users/login（302 到 dashboard）；
 * 密码错误 → URL 仍停在 /users/login。
 * 返回 { status: 'success' | 'wrong_password' | 'challenge' | 'error', message? }
 * - challenge: CF 人机验证，需要走 WebView
 */
export async function submitLogin(username, password) {
  if (!username || !password) return { status: 'error', message: '请输入用户名和密码' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    // 1. 拿 authenticity_token（失败=可能被 CF 拦截 → challenge）
    let token;
    try {
      token = await fetchLoginAuthenticityToken();
    } catch (e) {
      return { status: 'challenge', message: '登录页需要人机验证' };
    }

    // 2. POST 登录（必须 urlencoded，AO3 不认 multipart）
    const params = new URLSearchParams();
    params.append('authenticity_token', token);
    params.append('user[login]', username);
    params.append('user[password]', password);
    params.append('user[remember_me]', '1');
    params.append('commit', 'Log in');

    const response = await fetch('https://archiveofourown.org/users/login?return_to=%2F', {
      method: 'POST',
      body: params.toString(),
      credentials: 'include',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5',
        'Referer': 'https://archiveofourown.org/users/login?return_to=%2F',
        'Origin': 'https://archiveofourown.org',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Priority': 'u=0, i',
      },
    });
    clearTimeout(timer);

    // 3. CF 挑战检测（响应体特征）
    const html = await response.text();
    if (response.status === 403 || response.status === 503 ||
        html.includes('_cf_chl_opt') ||
        html.includes('challenges.cloudflare.com') ||
        html.includes('cdn-cgi/challenge-platform')) {
      return { status: 'challenge' };
    }

    // 4. 核心：旧版 URL 判断
    //    密码错误 → URL 仍停在 /users/login
    //    登录成功 → URL 跳离 login（成功 HAR 是 302 → https://archiveofourown.org/）
    const finalUrl = response.url || '';
    const stillOnLogin = finalUrl.includes('/users/login');
    if (stillOnLogin) {
      // 停在登录页：密码错误 或 未正确跳转（HAR 失败页是 "doesn't match"）
      if (html.includes('Wrong username or password') || html.includes("doesn't match") || html.includes('does not match') || html.includes('Invalid')) {
        return { status: 'wrong_password', message: '用户名或密码错误' };
      }
      return { status: 'error', message: '登录未跳转，请重试或使用官方登录' };
    }

    // 5. URL 已跳走 → 登录成功
    // 同步 cookie 到 Keychain
    try { await syncSessionFromNative(); } catch {}
    return { status: 'success' };
  } catch (error) {
    clearTimeout(timer);
    console.error('submitLogin error:', error);
    if (error && error.name === 'AbortError') {
      return { status: 'error', message: '请求超时，请检查网络' };
    }
    // ECH 失败/网络问题 → 走官方 WebView 兜底
    return { status: 'challenge', message: '网络异常，尝试官方登录' };
  }
}
