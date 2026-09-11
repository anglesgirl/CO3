import getUrl from '../requestManager';
import { getUsername, setUsernameOnly, setPseudOnly } from '../../storage/Credentials';

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

    // 未登录首页也可能出现 /users/... 链接，所以先确认登录态（有 Log Out 才算）
    const loggedIn = html.includes('Log Out') || html.includes('Log out') || html.includes('/users/logout');

    // 首选：导航栏用户菜单的权威链接
    let match = html.match(/\/users\/([^\/"'?#\s]+)\/pseuds\/([^\/"'?#\s]+)/);
    if (!match && loggedIn) {
      // 兜底：只拿到 username（没有 pseud 链接时）
      match = html.match(/\/users\/([^\/"'?#\s]+)\/(?:bookmarks|works|readings|preferences)/);
    }
    if (!match) return null;

    const username = decodeURIComponent(match[1]);
    const pseud = match[2] ? decodeURIComponent(match[2]) : null;
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
