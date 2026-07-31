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
import { echUrl } from '../echKy';

export const handleLogin = async (username, password) => {
  const t = i18n.t;

  if (!username || !password) {
    throw 'Please enter both username and password';
  }

  try {
    const sessionToken = await login(username, password);

    if (sessionToken) {
      await setCredsToken(sessionToken);
      const hadStoredPassword = await hasStoredPassword();
      if (!hadStoredPassword) {
        // Clear the old password/identity pair before writing the new
        // canonical identity. Do not let this erase the identity we are about
        // to store.
        await deleteCredsPasswd();
      }

      // Login accepts email, but all authenticated AO3 user routes require the
      // canonical username. Store that identity separately from the credential.
      const canonicalUsername = await resolveAuthenticatedUsername(sessionToken);
      const accountUsername = canonicalUsername || username;
      await setUsernameOnly(accountUsername);

      if (hadStoredPassword) {
        await setCredsToken(sessionToken);
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


// AO3 accepts an email as user[login], but account URLs require the
// canonical AO3 username. Resolve it from the authenticated home page after
// login instead of persisting the email as the path component.
export function parseAuthenticatedUsername(html) {
  // Prefer AO3's signed-in greeting. A generic page can contain links to other
  // users, so those must never be used as the current account identity.
  const greeting = String(html).match(/<[^>]+(?:id|class)=["'][^"']*\bgreeting\b[^"']*["'][^>]*>[\s\S]*?href=["']\/users\/([^\/'"?#]+)[\/'"]/i);
  if (greeting?.[1]) return decodeURIComponent(greeting[1]);
  const accountMenu = String(html).match(/<[^>]+(?:id|class)=["'][^"']*(?:user-menu|logged-in)[^"']*["'][^>]*>[\s\S]*?href=["']\/users\/([^\/'"?#]+)[\/'"]/i);
  if (accountMenu?.[1]) return decodeURIComponent(accountMenu[1]);
  // AO3's current navigation commonly renders the user link in a dropdown,
  // without either of the older greeting/menu wrapper classes.
  const signedInNav = String(html).match(/<li\b[^>]*\bclass=["'][^"']*\bdropdown\b[^"']*["'][^>]*>[\s\S]*?href=["']\/users\/([^\/'"?#]+)[\/'"]/i);
  return signedInNav?.[1] ? decodeURIComponent(signedInNav[1]) : null;
}

export async function resolveAuthenticatedUsername(sessionToken) {
  if (!sessionToken) return null;
  const response = await fetch(await echUrl('https://archiveofourown.org/'), {
    headers: {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Cookie: `user_credentials=1; _otwarchive_session=${sessionToken}`,
    },
  });
  if (!response.ok) return null;
  return parseAuthenticatedUsername(await response.text());
}

export default async function login(username, password) {
  try {
    // Prepare the form data
    const formData = new FormData();
    formData.append('authenticity_token', await fetchLoginAuthenticityToken());
    formData.append('user[login]', username);
    formData.append('user[password]', password);
    formData.append('user[remember_me]', '1');
    formData.append('commit', 'Log in');

    // Send the login request through the ECH proxy (a direct fetch would be
    // blocked on networks where AO3 is censored).
    const response = await fetch(await echUrl('https://archiveofourown.org/users/login'), {
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

    // Still on the login page (proxied or not) means the credentials failed.
    if (response.url && response.url.endsWith('/users/login')) {
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
      if (response.redirected || !response.url.endsWith('/users/login')) {
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    // Send a request to the website with the provided cookies
    const response = await fetch(await echUrl('https://archiveofourown.org/'), {
      method: 'GET',
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
  }
}
