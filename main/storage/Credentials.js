import * as Keychain from 'react-native-keychain';
import CookieManager from '@react-native-cookies/cookies';
import { NativeModules } from 'react-native';

const TIMESTAMP_SERVICE = 'creds_timestamp';

/**
 * 是否处于登录态 —— **读 Cookie 里的 user_credentials**，零网络请求。
 *
 * 这是 AO3 唯一可靠的真登录标志：
 *  - 匿名访问也会下发 `_otwarchive_session`，拿它判断会把未登录当成已登录；
 *  - 而存储里的 token 丢了/过期时，Cookie 里的 `user_credentials` 往往**还在**。
 *
 * 真机实测症状（只看存储 token 的写法）：账号中心显示"未登录"并引导去登录，
 * 用户点进去却被 AO3 告知 "You are already logged in to an account"。
 *
 * 优先用原生 CoCookieModule（直接读 CookieManager，HttpOnly 也读得到）；
 * 原生不可用时退回 @react-native-cookies 读同一份 Cookie。
 */
export async function hasUserCredentials() {
  try {
    const mod = NativeModules && NativeModules.CoCookieModule;
    if (mod && typeof mod.hasUserCredentials === 'function') {
      return !!(await mod.hasUserCredentials());
    }
  } catch (_) {}
  try {
    const cookies = await CookieManager.get('https://archiveofourown.org/', true);
    return !!(cookies && cookies.user_credentials);
  } catch (_) {
    return false;
  }
}

export async function setLastLogin() {
  try {
    await Keychain.setGenericPassword('last_login', new Date().toISOString(), {
      service: TIMESTAMP_SERVICE,
    });
  } catch (error) {
    console.error('Failed to update last login timestamp:', error);
  }
}

export async function getLastLogin() {
  try {
    const creds = await Keychain.getGenericPassword({ service: TIMESTAMP_SERVICE });
    return creds ? creds.password : null;
  } catch (error) {
    console.error('Failed to retrieve last login timestamp:', error);
    return null;
  }
}

export async function deleteLastLogin() {
  try {
    await Keychain.resetGenericPassword({ service: TIMESTAMP_SERVICE });
    console.log('Last login timestamp deleted.');
  } catch (error) {
    console.error('Failed to delete last login timestamp:', error);
    throw error;
  }
}

export async function getCredsPasswd() {
  try {
    const creds = await Keychain.getGenericPassword({
      service: 'creds_passwd',
      authenticationPrompt: {
        title: 'Authenticate to access saved credentials',
        subtitle: 'Access is protected by your biometrics or device passcode',
        description:
          'To ensure your security, you need to authenticate before the app can access your saved login information.',
      },
    });

    if (creds) {
      console.log('Credentials successfully loaded for user ' + creds.username);
      await setLastLogin();
      return creds; // Return credentials
    } else {
      console.log('No credentials stored for password service');
      return null;
    }
  } catch (error) {
    console.error('Failed to retrieve password credentials:', error);
    return null; // Return null on error
  }
}


export async function setCredsPasswd(usrname, passwd) {
  try {
    await Keychain.setGenericPassword(usrname, 'placeholder', {
      service: 'username_only',
    });

    await Keychain.setGenericPassword(usrname, passwd, {
      service: 'creds_passwd',
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      authenticationPrompt: {
        title: 'Authenticate to save your credentials',
        subtitle: 'Your credentials will be securely stored in the device Keychain',
        description: 'Authentication is required to securely save your login information. This allows the app to automatically log you in when needed.',
      }
    });
    console.log('Password successfully stored');
  } catch (error) {
    console.error('Failed to store password:', error);
    throw error;
  }
}

export async function getCredsToken() {
  try {
    const creds = await Keychain.getGenericPassword({ service: 'creds_token' });

    if (creds) {
      console.log('Token successfully loaded for user ' + creds.username);
      await setLastLogin();
      return creds.password; // Return the token value (which is stored as password)
    } else {
      console.log('No token stored');
      return null; // Return null if no token is stored
    }
  } catch (error) {
    console.error('Failed to retrieve token credentials:', error);
    return null; // Return null on error
  }
}

export async function setCredsToken(token) {
  try {

    await CookieManager.set('https://archiveofourown.org', {
      name: '_otwarchive_session',
      value: token,
      domain: 'archiveofourown.org',
      path: '/',
      version: '1',
      secure: true,
      httpOnly: true,
    });

    // Storing the token with a generic username 'ao3_token'
    await Keychain.setGenericPassword('ao3_token', token, { service: 'creds_token' });
    console.log('Token successfully stored');
  } catch (error) {
    console.error('Failed to store token:', error);
    throw error; // Re-throw to allow calling function to handle
  }
}

export async function deleteCredsPasswd() {
  try {
    await Keychain.resetGenericPassword({ service: 'creds_passwd' });
    await Keychain.resetGenericPassword({ service: 'username_only' });
    console.log('Password credentials deleted.');
  } catch (error) {
    console.error('Failed to delete password credentials:', error);
    throw error;
  }
}

export async function deleteCredsToken() {
  try {
    await Keychain.resetGenericPassword({ service: 'creds_token' });
    // 【清 Cookie 必须走原生】此前只调 @react-native-cookies 的 clearAll()，真机上
    // 清不掉 AO3 的登录 Cookie（作者原注释就写着"why does it remember cookie on its own"），
    // 表现为：点退出后**界面退了但账号没退**，下次进来仍是登录态
    //（用户实测反馈"点 log out 界面直接退出，账号并不会退出"）。
    // 原生 CoCookieModule.clearSession 是 removeAllCookies + 对 4 个 host 写
    // Max-Age=0 过期标记 + flush，专门解决 path="" 的 host-only cookie 删不掉的问题。
    let cleared = false;
    try {
      const mod = NativeModules && NativeModules.CoCookieModule;
      if (mod && typeof mod.clearSession === 'function') {
        cleared = !!(await mod.clearSession());
      }
    } catch (_) {
      cleared = false;
    }
    if (!cleared) {
      // 原生不可用时退回 JS 实现（至少尽力而为）
      await CookieManager.clearAll();
    }
    console.log('Token credentials deleted.');
  } catch (error) {
    console.error('Failed to delete token credentials:', error);
    throw error;
  }
}

export async function getUsername() {
  try {
    const creds = await Keychain.getGenericPassword({
      service: 'username_only',
    });

    if (creds) {
      console.log('Username retrieved: ' + creds.username);
      return creds.username;
    } else {
      console.log('No username stored');
      return null;
    }
  } catch (error) {
    console.error('Failed to retrieve username:', error);
    return null;
  }
}

export async function setUsernameOnly(username) {
  try {
    await Keychain.setGenericPassword(username, 'placeholder', {
      service: 'username_only',
    });
    console.log('Username stored');
  } catch (error) {
    console.error('Failed to store username:', error);
    throw error;
  }
}

/**
 * AO3 的 pseud（笔名）。书签/稍后读可以用 pseud 拼 URL，
 * 与 username 一起从登录后页面提取，避免用户手填。
 */
export async function setPseudOnly(pseud) {
  if (!pseud) return;
  try {
    await Keychain.setGenericPassword(pseud, 'placeholder', {
      service: 'pseud_only',
    });
  } catch (error) {
    console.error('Failed to store pseud:', error);
  }
}

export async function getPseud() {
  try {
    const creds = await Keychain.getGenericPassword({ service: 'pseud_only' });
    return creds ? creds.username : null;
  } catch (error) {
    console.error('Failed to retrieve pseud:', error);
    return null;
  }
}

export async function hasStoredPassword() {
  try {
    const creds = await Keychain.getGenericPassword({ service: 'username_only' });
    return creds !== false && creds !== null;
  } catch (error) {
    console.error('Failed to check for stored password:', error);
    return false;
  }
}