import { fetchLoginFormFields } from './fetchAuthenticityToken';
import { fetchAccountIdentity, clearIdentityCache, looksLikeEmail } from './accountIdentity';
import { diagEvent } from '../../utils/diag';
import Toast from 'react-native-toast-message';
import {
  deleteCredsPasswd,
  getPseud,
  hasStoredPassword,
  setCredsToken,
  setLastLogin,
  setPseudOnly,
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
      }

      // 【关键修复】存进 Credentials 的必须是 AO3 的**真实 username**，而不是登录输入值。
      // 用邮箱登录时两者不同，而书签 / 稍后读 / 用户作品页的 URL 都是 /users/<username>/...，
      // 存成邮箱就会 404 —— 这是作者原版账号中心一直存在的老 bug（没人报，作者也不知道）。
      let storedName = username;
      try {
        clearIdentityCache();
        const identity = await fetchAccountIdentity(true);
        if (identity && identity.username) {
          storedName = identity.username;
          if (identity.pseud) await setPseudOnly(identity.pseud);
        }
      } catch (e) {
        console.error('resolve real username failed:', e);
      }
      await setUsernameOnly(storedName);
      diagEvent('login_step', {
        step: 'account_identity',
        inputIsEmail: looksLikeEmail(username).toString(),
        resolved: String(storedName || '').slice(0, 40),
        pseud: String((await getPseud()) || '').slice(0, 40),
      });

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
    // 表单编码铁律（2026-08-31 血泪，二次复发）：
    // AO3 是 Rails，登录 POST 只认 application/x-www-form-urlencoded。
    // 绝对不能用 FormData —— RN 的 fetch 会把它序列化成
    // multipart/form-data; boundary=...，服务端视为无效请求，
    // 返回 200 重渲染登录页（仅有 _otwarchive_session，无 user_credentials）。
    // 日志特征：ech_req_body ctype=multipart/... + post_login status=200 且 finalUrl 仍含 /users/login
    const params = new URLSearchParams();
    const { token, commit } = await fetchLoginFormFields();
    params.append('authenticity_token', token);
    params.append('user[login]', username);
    params.append('user[password]', password);
    params.append('user[remember_me]', '1');
    // commit 与页面语言配套：HAR 成功样本是中文页的"用户登录"，写死 'Log in' 会与页面不符
    params.append('commit', commit);

    // Send the login request
    // 下面这组 URL/请求头是照 HAR 里"官方浏览器成功登录"那条请求 1:1 对齐的：
    //   POST /users/login?return_to=%2F
    //   Origin: https://archiveofourown.org          <- 浏览器会自动带，RN fetch 不会，必须手写
    //   Referer: https://archiveofourown.org/users/login?return_to=%2F  <- 必须带 query
    // 实测教训：缺 Origin 或 Referer 丢了 query，AO3 会返回 400 Bad Request
    //（此前一直卡在登录失败，根因就在这里）。
    const LOGIN_URL = 'https://archiveofourown.org/users/login?return_to=%2F';
    const response = await fetch(LOGIN_URL, {
      method: 'POST',
      body: params.toString(),
      credentials: 'include', // Important for cookies
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        // 与 HAR 成功样本一致（中文界面）；页面语言决定 commit 按钮值，故两者必须配套
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        // Content-Type 必须显式声明为 urlencoded（RN 传字符串 body 时默认给 text/plain）
        'Content-Type': 'application/x-www-form-urlencoded',
        // 不要手写 Accept-Encoding：交给 OkHttp 自动协商，手写会导致响应体未解压
        Origin: 'https://archiveofourown.org',
        Referer: LOGIN_URL,
        // 下面这批是浏览器自动携带、RN fetch 一律不会加的头，HAR 成功样本里都有
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        Priority: 'u=0, i',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      }, //Yea cloudflare was hard on this one, so i'm officially a web browser YaY
      //Like fr i'm a win 10 machine on chrome wdym
      //We just need to pray cloudflare will leave me alone
    });

    // 登录链路第 5 步：POST 结果（302 跳出登录页=成功；仍停在登录页=被拒）
    diagEvent('login_step', {
      step: 'post_login',
      status: response.status,
      finalUrl: String(response.url || '-').slice(0, 80),
      setCookie: response.headers && response.headers.get && response.headers.get('set-cookie') ? 'yes' : 'no',
    });
    // 仍在登录页 = 被拒。必须用 includes：服务端/我们发出的 URL 都带 ?return_to=%2F，
    // 用 === 比较会永远不匹配 → 200 被误判成"成功但没 cookie"。
    if (String(response.url || '').includes('/users/login')) {
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
        !String(response.url || '').includes('/users/login')
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
    // Send a request to the website with the provided cookies
    const response = await fetch('https://archiveofourown.org/', {
      method: 'GET',
      credentials: 'include', // Include cookies in the request
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Cookie': `user_credentials=1; _otwarchive_session=${sessionToken}` // Attach both cookies
      }
    });

    // Check the response headers for the "set-cookie" header
    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      // Look for the "user_credentials" cookie being cleared
      const cookies = setCookieHeader.split(',');
      for (let cookie of cookies) {
        const trimmedCookie = cookie.trim();
        if (trimmedCookie.startsWith('user_credentials=') && trimmedCookie.includes('max-age=0')) {
          console.log("Cookie invalid !")
          return false;
        }
      }
    }

    console.log("Cookie verified !")

    // If the "user_credentials" cookie is not cleared, the token is valid
    return true;

  } catch (error) {
    console.error('Error validating cookie:', error);
    throw error;
  }
}
