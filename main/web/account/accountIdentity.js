import getUrl from '../requestManager';
import { getUsername, setUsernameOnly, setPseudOnly } from '../../storage/Credentials';
import { diagEvent } from '../../utils/diag';

/**
 * 取真实的 AO3 账号身份（username + pseud）。
 *
 * 【为什么必须单独取】用户用邮箱登录时，登录输入值 `anglesgirlcn@gmail.com` ≠ AO3 用户名，
 * 而书签 / 稍后读 / 用户作品页的 URL 都形如
 *   /users/<username>/bookmarks
 *   /users/<username>/readings?show=to-read
 * 用邮箱去拼就是 404（作者原版的账号中心一直是这么错的，属于老 bug）。
 *
 * 来源：登录后页面导航栏里的用户菜单链接 `/users/<username>/pseuds/<pseud>`，
 * 这是 AO3 自己给出的权威值（不靠猜、不靠用户手填）。
 */

let cachedIdentity = null;

export function looksLikeEmail(value) {
  return !!value && typeof value === 'string' && value.includes('@');
}

/**
 * @param {boolean} force 忽略缓存重新取（登录后建议 force=true）
 * @returns {{username: string, pseud: string|null}|null}
 */
export async function fetchAccountIdentity(force = false) {
  if (cachedIdentity && !force) return cachedIdentity;
  try {
    const html = await getUrl('https://archiveofourown.org/', false);
    if (!html || typeof html !== 'string') return null;

    const loggedIn = html.includes('Log Out') || html.includes('Log out') || html.includes('/users/logout');

    // 【为什么不用 /users/X/pseuds/Y】服务器实测（真实账号抓 AO3 首页）：
    // 首页推荐位里就含**别人的** /users/<别人>/pseuds/<别人>，
    // 用它当首选会把当前用户名解析成陌生作者（书签/稍后读 URL 随之全错）。
    // 权威锚点是**只有当前登录用户才可能有**的这些链接：
    //   /users/X/preferences  /users/X/subscriptions  /users/X/readings
    // 次选导航栏 "Hi, xxx!" 的那个链接。
    const m =
      html.match(/\/users\/([^\/"'?#\s]+)\/(?:preferences|subscriptions|readings)/)
      || html.match(/<a[^>]+href="\/users\/([^\/"'?#\s]+)"[^>]*>\s*Hi,/i)
      || (loggedIn ? html.match(/\/users\/([^\/"'?#\s]+)\/(?:bookmarks|works)/) : null);
    if (!m) return null;

    const username = decodeURIComponent(m[1]);
    // pseud：导航栏 "Hi, <pseud>!" 的文本（首页没有 /users/X/pseuds/Y 链接时唯一的来源）
    let pseud = null;
    const pm = html.match(/<a[^>]+href="\/users\/[^"'?#\s\/]+"[^>]*>\s*Hi,\s*([^<]+?)\s*</i);
    if (pm) pseud = decodeURIComponent(pm[1].replace(/[!！]\s*$/, '').trim()) || null;

    diagEvent('account_identity', {
      html_len: html.length,
      logged_in: loggedIn,
      matched: m[0].slice(0, 40),
      user_head: username.slice(0, 3),
      pseud_head: pseud ? pseud.slice(0, 3) : '-',
    });

    cachedIdentity = { username, pseud };
    return cachedIdentity;
  } catch (error) {
    console.error('fetchAccountIdentity failed:', error);
    return null;
  }
}

export function clearIdentityCache() {
  cachedIdentity = null;
}

/**
 * 取"可用于拼 URL 的真实用户名"，并顺手自愈历史脏数据。
 *
 * 老版本把登录输入值（可能是邮箱）存成了 username，导致所有
 * /users/<username>/... 的地址 404。这里在每次使用时兜底：
 *   存的是邮箱 / 没存  → 从页面取真实 username 覆盖存储后再返回。
 * 这样不依赖启动时机，任何入口都会自愈。
 */
export async function getRealUsername() {
  let stored = null;
  try {
    stored = await getUsername();
  } catch (_) {
    stored = null;
  }

  if (stored && !looksLikeEmail(stored)) return stored;

  const identity = await fetchAccountIdentity(true);
  if (identity && identity.username) {
    try {
      await setUsernameOnly(identity.username);
      if (identity.pseud) await setPseudOnly(identity.pseud);
    } catch (_) {}
    return identity.username;
  }
  // 取不到就退回旧值：宁可让上层试一次，也不要直接让功能不可用
  return stored;
}
