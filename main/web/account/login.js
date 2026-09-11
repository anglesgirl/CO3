import { fetchLoginAuthenticityToken } from './fetchAuthenticityToken';
import { diagEvent } from '../../utils/diag';
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
    // 下面这组 URL/请求头是照 HAR 里"官方浏览器成功登录"那条请求 1:1 对齐的：
    //   POST /users/login?return_to=%2F
    //   Origin: https://archiveofourown.org          <- 浏览器会自动带，RN fetch 不会，必须手写
    //   Referer: https://archiveofourown.org/users/login?return_to=%2F  <- 必须带 query
    // 实测教训：缺 Origin 或 Referer 丢了 query，AO3 会返回 400 Bad Request
    //（此前一直卡在登录失败，根因就在这里）。
    const LOGIN_URL = 'https://archiveofourown.org/users/login?return_to=%2F';
    const response = await fetch(LOGIN_URL, {
      method: 'POST',
      body: formData,
      credentials: 'include', // Important for cookies
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        Origin: 'https://archiveofourown.org',
        Referer: LOGIN_URL,
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
