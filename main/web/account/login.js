import { fetchLoginAuthenticityToken } from './fetchAuthenticityToken';
import { syncSessionFromNative } from '../syncSession';
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
    // Prepare the form data
    const formData = new FormData();
    formData.append('authenticity_token', await fetchLoginAuthenticityToken());
    formData.append('user[login]', username);
    formData.append('user[password]', password);
    formData.append('user[remember_me]', '1');
    formData.append('commit', 'Log in');

    // Send the login request
    const response = await fetch('https://archiveofourown.org/users/login', {
      method: 'POST',
      body: formData,
      credentials: 'include', // Important for cookies
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        Referer: 'https://archiveofourown.org/users/login',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
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
export async function validateCookie(sessionToken) {
  try {
    // 15s 超时：ECH 失败/网络问题时不至于一直转圈
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    // 请求必须登录的页面 /users/dashboard：
    // 真登录 → 200 + 页面含用户名/退出链接（无登录表单）
    // 未登录/过期 → 302 到 /users/login 或返回登录页（含 user[password] 表单）
    const response = await fetch('https://archiveofourown.org/users/dashboard', {
      method: 'GET',
      credentials: 'include', // Include cookies in the request
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Cookie': `user_credentials=1; _otwarchive_session=${sessionToken}` // Attach both cookies
      }
    });
    clearTimeout(timer);

    const html = await response.text();
    const finalUrl = response.url || '';

    // 1. 被重定向到登录页 → 未登录/过期
    if (finalUrl.includes('/users/login') || finalUrl.includes('/login')) {
      return false;
    }
    // 2. 返回的是登录表单（password 输入框）→ 未登录
    if (html.includes('user[password]') || html.includes('user_password') || html.includes('new_user')) {
      return false;
    }
    // 3. dashboard 页成功（200 且含 logout/用户菜单）→ 真登录
    if (response.status === 200 &&
        (html.includes('Log Out') || html.includes('log_out') || html.includes('logout') ||
         html.includes('Dashboard') || html.includes('dashboard'))) {
      return true;
    }
    // 4. 兜底：无法确认
    return false;
  } catch (error) {
    console.error('Error validating cookie:', error);
    throw error;
  }
}

/**
 * 原生表单登录提交（账号中心用）。
 * 返回 { status: 'success' | 'wrong_password' | 'challenge' | 'error', message? }
 * - challenge: CF 人机验证，需要走 WebView
 */
export async function submitLogin(username, password) {
  if (!username || !password) return { status: 'error', message: '请输入用户名和密码' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    // 1. 拿 authenticity_token
    let token;
    try {
      token = await fetchLoginAuthenticityToken();
    } catch (e) {
      // 拿 token 时可能已被 CF 挑战拦截
      return { status: 'challenge', message: '登录页需要人机验证' };
    }

    // 2. POST 登录
    const formData = new FormData();
    formData.append('authenticity_token', token);
    formData.append('user[login]', username);
    formData.append('user[password]', password);
    formData.append('user[remember_me]', '1');
    formData.append('commit', 'Log in');

    const response = await fetch('https://archiveofourown.org/users/login', {
      method: 'POST',
      body: formData,
      credentials: 'include',
      signal: ctrl.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Referer': 'https://archiveofourown.org/users/login',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    clearTimeout(timer);

    const html = await response.text();

    // 3. CF 挑战检测
    if (response.status === 403 || response.status === 503 ||
        html.includes('_cf_chl_opt') ||
        html.includes('challenges.cloudflare.com') ||
        html.includes('cdn-cgi/challenge-platform')) {
      return { status: 'challenge' };
    }

    // 4. 密码错误
    if (html.includes('Wrong username or password') || html.includes('Invalid')) {
      return { status: 'wrong_password', message: '用户名或密码错误' };
    }

    // 5. 登录成功判定：页面不含登录表单（没有密码输入框）且状态 200
    const stillLoginPage = html.includes('user[password]') || html.includes('user_password') || html.includes('new_user');
    if (!stillLoginPage) {
      // 同步 cookie 到 Keychain
      try { await syncSessionFromNative(); } catch {}
      return { status: 'success' };
    }

    // 6. 兜底：无法判断
    return { status: 'error', message: '无法确认登录结果，请重试或使用官方登录' };
  } catch (error) {
    clearTimeout(timer);
    console.error('submitLogin error:', error);
    if (error && error.name === 'AbortError') {
      return { status: 'error', message: '请求超时，请检查网络' };
    }
    // ECH 失败/网络问题
    return { status: 'challenge', message: '网络异常，尝试官方登录' };
  }
}
