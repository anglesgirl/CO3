import getUrl from '../requestManager';

/**
 * 应用内发起「找回密码」（不跳网页）。
 *
 * 【为什么不走网页】用户要求："能用我们自己的窗体就用我们自己的窗体，
 * 不要什么都往网页里搬。"
 * 另外实测发现：AO3 对**已登录**用户访问 /users/password/new 直接返回 403
 *（不允许已登录状态重置密码）—— 所以这个入口本来就只在未登录时才有意义，
 * 之前已登录还点它，必然"点进去直接退回"。
 *
 * 【字段名不写死】authenticity_token、表单 action、邮箱输入框的 name
 * 全部**从页面实际表单里提取**。AO3 若改表单结构也能自适应，
 * 也避免"用了过时字段名 → 提交被静默忽略"这类问题（这类坑踩过好几次）。
 */

const PAGE = 'https://archiveofourown.org/users/password/new';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

/**
 * @returns {{ok: boolean, status?: number, message: string}}
 */
export async function requestPasswordReset(email) {
  if (!email || !String(email).includes('@')) {
    return { ok: false, message: 'email_invalid' };
  }

  const page = await getUrl(PAGE, false);
  const html = String(page || '');

  const token = (html.match(/name="authenticity_token"\s+value="([^"]+)"/) || [])[1];
  if (!token) {
    return { ok: false, message: 'no_token' };
  }

  // 取出与 password/email 相关的那个表单
  const forms = html.match(/<form[^>]*>[\s\S]*?<\/form>/g) || [];
  const formTag = forms.find((s) => /password|email/i.test(s)) || '';
  const action = (formTag.match(/action="([^"]*)"/) || [])[1] || '/users/password';
  const emailField =
    (formTag.match(/<input[^>]*name="([^"]*email[^"]*)"[^>]*>/i) || [])[1] ||
    (formTag.match(/<input[^>]*type="(?:text|email)"[^>]*name="([^"]+)"/i) || [])[1];

  if (!emailField) {
    return { ok: false, message: 'no_email_field' };
  }

  const url = action.startsWith('http')
    ? action
    : `https://archiveofourown.org${action.startsWith('/') ? '' : '/'}${action}`;

  const params = new URLSearchParams();
  params.append('authenticity_token', token);
  params.append(emailField, String(email).trim());
  params.append('commit', 'Reset password');

  const res = await fetch(url, {
    method: 'POST',
    body: params.toString(),
    credentials: 'include',
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://archiveofourown.org',
      Referer: PAGE,
      'User-Agent': UA,
    },
  });

  const text = await res.text();
  // AO3 成功后会提示"已发送/重置"类信息；只要不是明确的错误页就算受理
  const looksOk =
    res.ok ||
    res.status === 302 ||
    /reset|sent|check your email|instructions/i.test(text);
  const wrongEmail = /not found|no account|invalid/i.test(text) && !looksOk;

  return {
    ok: looksOk && !wrongEmail,
    status: res.status,
    message: wrongEmail ? 'email_not_found' : looksOk ? 'ok' : `http_${res.status}`,
  };
}
