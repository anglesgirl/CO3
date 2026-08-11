import { fetchLoginAuthenticityToken } from './fetchAuthenticityToken';
import Toast from 'react-native-toast-message';
import {
  deleteCredsPasswd, deleteCredsToken, hasStoredPassword,
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

    if (!sessionToken) {
      throw new Error(t('screen_account_login_failed_invalid_server_error'));
    }

    await setCredsToken(sessionToken);

    // ⚠️ 用「能否解析出已登录用户名」验证会话真的有效，而不是"拿到 cookie 就算登录"。
    // AO3 在密码错误时也会下发 session cookie（实测 302 → /auth_error），
    // 只有真正登录后首页才会渲染 greeting/用户菜单里的 /users/<name> 链接。
    const canonicalUsername = await resolveAuthenticatedUsername(sessionToken);
    if (!canonicalUsername) {
      // 会话无效：清掉刚存的 token，避免 App 之后带着废 cookie 请求，
      // 表现成"登录成功但处处不正常"。
      try { await deleteCredsToken(); } catch {}
      const e = new Error(t('screen_account_login_failed_invalid_creds_or_server_error'));
      e.code = 'SESSION_NOT_AUTHENTICATED';
      throw e;
    }

    const hadStoredPassword = await hasStoredPassword();
    if (!hadStoredPassword) {
      // Clear the old password/identity pair before writing the new
      // canonical identity. Do not let this erase the identity we are about
      // to store.
      await deleteCredsPasswd();
    }

    // Login accepts email, but all authenticated AO3 user routes require the
    // canonical username. Store that identity separately from the credential.
    await setUsernameOnly(canonicalUsername);

    if (hadStoredPassword) {
      await setCredsToken(sessionToken);
    }

    await setLastLogin();
    Toast.show({
      type: 'success',
      text1: t('general_success'),
      text2: t('screen_account_login_success'),
    })
  } catch (error) {
    console.error('Login error:', error?.message ?? error);
    // 保留可区分的错误信息，别把"密码错误 / 人机验证 / 网络失败"全糊成一句
    // 通用文案——用户看不出该改密码还是该换网络。
    if (error?.code === 'BAD_CREDENTIALS') {
      throw t('screen_account_login_failed_invalid_creds_or_server_error');
    }
    if (error?.code === 'CF_CHALLENGE') {
      throw error; // 调用方据此走人机验证流程
    }
    throw error?.message || t('screen_account_login_failed_generic');
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

/**
 * 会话是否真的处于已登录态。用于登录后校验和会话过期检测。
 * 返回 { ok, username }。
 */
export async function checkSession(sessionToken) {
  try {
    const username = await resolveAuthenticatedUsername(sessionToken);
    return { ok: !!username, username: username ?? null };
  } catch (e) {
    console.warn('[login] session check failed:', e?.message ?? e);
    return { ok: false, username: null };
  }
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
    //
    // 2026-08-11：**不再伪装 Chrome User-Agent**。TLS 握手由 Go 代理完成，
    // 声称自己是 Chrome 会产生 UA/指纹不一致，正是 Cloudflare 判定自动化的
    // 特征之一（accountRequests.js 里已有同样结论并照此实现）。实测
    // 不带 UA 直取登录页同样 HTTP 200。
    const response = await fetch(await echUrl('https://archiveofourown.org/users/login'), {
      method: 'POST',
      body: formData,
      credentials: 'include', // Important for cookies
      redirect: 'manual',     // 需要读 302 的 Location 判断成功/失败
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        Referer: 'https://archiveofourown.org/users/login',
      },
    });

    const setCookieHeader = response.headers.get('set-cookie') || '';
    const location = response.headers.get('location') || '';

    // ⚠️ 关键修正（2026-08-11 实测 AO3 真实响应）：
    // 密码错误时 AO3 也会 302 并**照样下发 _otwarchive_session**，只是
    // Location 指向 /auth_error。旧逻辑「拿到 session cookie 就算成功」
    // 会把失败当成功保存，之后所有请求都是未登录态 —— 这正是"登录了但不正常"。
    // 成功的标志是 user_credentials=1；这里同时用 Location 兜底判断。
    const loggedOutRedirect = /\/auth_error|\/users\/login/i.test(location);
    const grantedCredentials = /user_credentials=1/i.test(setCookieHeader);

    if (loggedOutRedirect && !grantedCredentials) {
      const e = new Error('Wrong username or password');
      e.code = 'BAD_CREDENTIALS';
      throw e;
    }

    // 仍停在登录页（非 302 情况）也说明认证没过。
    if (response.url && response.url.endsWith('/users/login') && !grantedCredentials) {
      const e = new Error('Wrong username or password');
      e.code = 'BAD_CREDENTIALS';
      throw e;
    }

    // Cloudflare 人机验证：403/503 或挑战页 —— 与凭据错误区分开，
    // 让调用方可以弹 WebView 过验证而不是提示"密码错误"。
    if (response.status === 403 || response.status === 503) {
      const e = new Error(`AO3/Cloudflare blocked the login request (HTTP ${response.status}).`);
      e.code = 'CF_CHALLENGE';
      throw e;
    }

    // Extract the session cookie from the response headers.
    // 注意：多个 Set-Cookie 被合并成一行时以 ", " 分隔，但 cookie 的 Expires
    // 里本身含逗号（"Tue, 25 Aug 2026 ..."），按 ',' 硬split 会把一条 cookie
    // 切成两半 → 匹配失败。改为直接在整串里正则取值。
    const sessionMatch = setCookieHeader.match(/_otwarchive_session=([^;,\s]+)/i);
    if (sessionMatch) {
      return sessionMatch[1];
    }

    if (response.status >= 200 && response.status < 400) {
      console.log(
        'Login appears successful but session cookie not found in headers',
      );
      return null;
    }

    throw new Error(`Login failed: ${response.status} ${response.statusText}`);
  } catch (error) {
    console.error('Login error:', error?.message ?? error);
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
    // 2026-08-11：不再伪装 Chrome UA（与 login() 一致，避免 CF 指纹不符）。
    const response = await fetch(await echUrl('https://archiveofourown.org/'), {
      method: 'GET',
      signal: controller.signal,
      credentials: 'include', // Include cookies in the request
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cookie': `user_credentials=1; _otwarchive_session=${sessionToken}` // Attach both cookies
      }
    });

    // Check the response headers for the "set-cookie" header
    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      // user_credentials 被清空 => 会话无效。
      // 注意不能按 ',' 切分（Expires 里含逗号），直接整串正则。
      if (/user_credentials=[^;,]*;[^,]*max-age=0/i.test(setCookieHeader)) {
        console.log("Cookie invalid !")
        return false;
      }
    }

    // 更可靠的判据：页面里能不能解析出当前登录用户。仅靠 set-cookie 猜测
    // （原注释里作者自己写的 "guess"）在 AO3 改版后经常误判为有效。
    const html = await response.text();
    if (parseAuthenticatedUsername(html)) {
      console.log("Cookie verified (authenticated markup found)")
      return true;
    }

    // 没有登录标记：可能是 CF 挑战页，也可能确实掉登录。挑战页不算失效。
    if (html.includes('_cf_chl_opt') || /challenge-platform/.test(html)) {
      console.log("Cookie check inconclusive (Cloudflare challenge page)")
      return true;
    }

    console.log("Cookie invalid (no authenticated markup)")
    return false;

  } catch (error) {
    console.error('Error validating cookie:', error?.message ?? error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
