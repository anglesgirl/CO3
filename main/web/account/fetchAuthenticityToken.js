import ky from '../echKy';
import getUrl from '../requestManager';

/**
 * 从表单页 HTML 里取 Rails CSRF token。
 *
 * 2026-08-11 修正：原实现用 DOM 走 `#new_user.childNodes[0].getAttribute('value')`，
 * 依赖「表单第一个子节点就是 token input」。实测 AO3 登录页（curl 抓真实 HTML）
 * 该表单首个子节点是空白文本节点，且 AO3 随时可能在 token 前插入元素 →
 * 取到 null 或直接抛错。改为按属性正则匹配（与 accountRequests.js 里
 * 已在用的 extractAuthenticityToken 同一套做法），属性顺序无关。
 */
function extractAuthenticityToken(html) {
  const patterns = [
    /name="authenticity_token"[^>]*\bvalue="([^"]+)"/i,
    /\bvalue="([^"]+)"[^>]*name="authenticity_token"/i,
    /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = String(html).match(re);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'");
}

export async function fetchLoginAuthenticityToken() {
  try {
    const html = await ky.get('https://archiveofourown.org/users/login').text();

    if (html.includes('You are already logged in to an account. Please log out and try again.')) {
      throw new Error('already logged in.');
    }
    // Cloudflare 挑战页也是 200，但没有表单——分开报错，否则用户只看到
    // "找不到 token" 这种无从下手的信息。
    if (html.includes('_cf_chl_opt') || /challenge-platform/.test(html)) {
      const e = new Error('AO3 returned a Cloudflare challenge page for the login form.');
      e.code = 'CF_CHALLENGE';
      throw e;
    }

    const token = extractAuthenticityToken(html);
    if (!token) {
      // 不再 console.log 整页 HTML（几十 KB 刷屏且可能含敏感内容），
      // 只打印长度和开头，够定位问题。
      console.warn(
        `[login] authenticity_token not found in login page (len=${html.length}): ` +
        `${html.slice(0, 200).replace(/\s+/g, ' ')}`,
      );
      throw new Error('Could not read AO3 login form token (the site may have changed).');
    }
    return token;
  } catch (e) {
    console.error('An error occurred while running fetchLoginAuthenticityToken', e?.message ?? e);
    throw e;
  }
}

export async function fetchKudoAuthenticityToken(workId) {
  try {
    const html = await getUrl('https://archiveofourown.org/works/' + workId);

    // 同上：token 位置不能靠 childNodes 下标猜。先在 new_kudo 表单范围内找，
    // 找不到再退回整页（AO3 页面里 kudo token 与页面 csrf-token 一致）。
    const formMatch = String(html).match(
      /<form[^>]*id="new_kudo"[^>]*>([\s\S]*?)<\/form>/i,
    );
    const scoped = formMatch ? extractAuthenticityToken(formMatch[0]) : null;
    const token = scoped || extractAuthenticityToken(html);
    if (!token) {
      throw new Error('Authenticity token not found for kudos (login may have expired).');
    }
    return token;
  } catch (e) {
    console.error('An error occurred while running fetchKudoAuthenticityToken', e?.message ?? e);
    throw e; // Re-throw to allow caller to handle
  }
}
