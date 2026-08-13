// accountRequests.js — AO3 account flows. 2026-08-13 起, 涉及账号验证的
// 流程(密码重置/注册/激活)统一改为在 WebView 打开官方页面完成 —— 客户端
// 不再改写这些表单(原生 fetch POST 在 GFW 内必被 CF challenge, 且官方
// 服务端做域名检查)。WebView 是真浏览器, CF 验证/表单交互/反钓鱼检查
// 全部按官方流程走; 提交成功(302 离开表单页)自动关窗。
//
// 邀请申请(requestInvitation)保留原生实现: 公开表单无需账号验证,
// 用户实测提交成功(2026-08-13)。

import ky, { echUrl } from '../echKy';
import { fetchViaWebView } from '../WebviewFetcher';
import { mergeQueueInfo, parseInvitationQueue } from './invitationQueue';

const BASE = 'https://archiveofourown.org';

// Deliberately NOT spoofing a browser User-Agent. The TLS handshake is done by
// the Go proxy, so claiming to be Chrome produces a fingerprint/UA mismatch that
// Cloudflare flags with a 403. Plain requests — exactly what the rest of the app
// sends for browsing — pass fine.
const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// Pulls the Rails CSRF token out of a form page. Attribute order varies, so we
// look for the input by name and then read its value either side of the name.
function extractAuthenticityToken(html) {
  const patterns = [
    /name="authenticity_token"[^>]*\bvalue="([^"]+)"/i,
    /\bvalue="([^"]+)"[^>]*name="authenticity_token"/i,
    /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtml(m[1]);
  }
  throw new Error('Could not find the form token (AO3 may have changed).');
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(s) {
  return decodeHtml(String(s).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// AO3 reports the outcome in a flash message; reading that keeps us correct
// even when the exact wording changes.
function readOutcome(html) {
  const notice = html.match(
    /<div[^>]*class="[^"]*flash[^"]*notice[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (notice) return { ok: true, message: stripTags(notice[1]) };

  const error = html.match(
    /<div[^>]*class="[^"]*(?:flash[^"]*error|error)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (error) {
    const msg = stripTags(error[1]);
    if (msg) return { ok: false, message: msg };
  }
  return null;
}

async function postForm(path, fields, referer) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);

  const res = await fetch(await echUrl(BASE + path), {
    method: 'POST',
    body,
    credentials: 'omit', // cookie 由 Go 代理 jar 管理
    headers: { ...BROWSER_HEADERS, Referer: referer },
  });
  const html = await res.text();
  return { res, html };
}

// Cloudflare sometimes 403s a "cold" request to a form page. Fetching the home
// page first gives the proxy's cookie jar a session, after which the form loads.
async function fetchWithWarmup(path) {
  try {
    return await ky.get(BASE + path, { headers: BROWSER_HEADERS }).text();
  } catch (e) {
    const status = e?.response?.status;
    if (status !== 403 && status !== 503) throw e;
    try {
      await ky.get(BASE + '/', { headers: BROWSER_HEADERS }).text();
    } catch {}
    try {
      return await ky
        .get(BASE + path, {
          headers: { ...BROWSER_HEADERS, Referer: BASE + '/' },
        })
        .text();
    } catch (e2) {
      const s2 = e2?.response?.status;
      if (s2 === 403 || s2 === 503) {
        throw new Error(
          'AO3 is currently blocking automated requests (HTTP ' +
            s2 +
            '). Please try again later.',
        );
      }
      throw e2;
    }
  }
}

async function getForm(path) {
  const html = await fetchWithWarmup(path);
  return { html, token: extractAuthenticityToken(html) };
}

function invitationPageError() {
  const error = new Error('AO3 invitation page is unavailable (HTTP 404).');
  error.code = 'INVITE_PAGE_NOT_FOUND';
  return error;
}

export async function getInvitationQueueInfo(email) {
  let publicHtml;
  try {
    publicHtml = await fetchWithWarmup('/invite_requests');
  } catch (error) {
    if (error?.response?.status === 404) {
      throw invitationPageError();
    }
    throw error;
  }

  const publicInfo = parseInvitationQueue(publicHtml);
  if (!email?.trim()) return publicInfo;

  let statusHtml;
  try {
    statusHtml = await ky
      .get(BASE + '/invite_requests/show', {
        headers: BROWSER_HEADERS,
        searchParams: { email: email.trim(), commit: 'Look me up' },
      })
      .text();
  } catch (error) {
    // AO3 已移除 "Look me up" 队列查询表单(2026-08-13 实测 /invite_requests
    // 页面只有申请表单,无 show 表单)或请求被 CF 拦 —— 队列状态查询失败
    // 绝不能让已成功的提交显示失败,降级返回公开队列信息。
    console.warn(
      '[invite] queue status lookup failed, degrading to public info:',
      error?.message ?? String(error),
    );
    return publicInfo;
  }
  return mergeQueueInfo(publicInfo, parseInvitationQueue(statusHtml));
}

/**
 * 通用: 在 WebView 打开官方页面完成账号操作(客户端不再改写这些流程)。
 * `fields` 存在时自动填入官方表单并提交(如忘记密码的邮箱); 否则直接
 * 打开页面由用户操作(如激活链接)。提交成功 = 302 离开表单页, 自动关窗。
 * 失败(校验错误/无效链接)渲染同页不导航, 用户看到错误可重试或关闭。
 */
async function completeInOfficialPage(url, fields = null) {
  const result = await fetchViaWebView(url, {
    interactiveLogin: true,
    fields,
  });
  if (!result) throw new Error('The official page was not completed.');
  return result;
}

/**
 * Requests a password-reset email. `login` may be a username or an email.
 * Opens AO3's official reset page in a WebView and auto-fills the login
 * field. Resolves with a message to show the user.
 */
export async function requestPasswordReset(login) {
  if (!login || !login.trim()) throw new Error('Enter your username or email.');
  await completeInOfficialPage(
    'https://archiveofourown.org/users/password/new',
    [{ name: 'user[login]', value: login.trim() }],
  );
  return 'If that account exists, a reset email is on its way. Check your spam folder.';
}

// --- registration (invitation -> signup -> activation) --------------------

/**
 * Accepts either a full invitation URL from AO3's email or a bare token, and
 * returns the token. Handles both /signup/TOKEN and ?invitation_token=TOKEN.
 */
export function extractInvitationToken(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Paste the invitation link from your email.');
  const q = s.match(/invitation_token=([A-Za-z0-9_-]+)/i);
  if (q) return q[1];
  const p = s.match(/\/signup\/([A-Za-z0-9_-]+)/i);
  if (p) return p[1];
  const inv = s.match(/\/invitations\/([A-Za-z0-9_-]+)/i);
  if (inv) return inv[1];
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s; // already a bare token
  throw new Error('That does not look like an AO3 invitation link.');
}

/**
 * Reads every <input> of the signup form so we can replay AO3's own hidden
 * fields instead of guessing them. Returns { fields, action }.
 */
function parseFormFields(html, formHint = 'new_user') {
  // Narrow to the signup form when we can find it.
  let scope = html;
  const formRe = new RegExp(
    `<form[^>]*(?:id="${formHint}"|action="[^"]*\\/users")[^>]*>([\\s\\S]*?)<\\/form>`,
    'i',
  );
  const fm = html.match(formRe);
  if (fm) scope = fm[0];

  const action = (scope.match(/<form[^>]*action="([^"]+)"/i) || [])[1] || '/users';

  const fields = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(scope)) !== null) {
    const tag = m[0];
    const name = (tag.match(/\bname="([^"]+)"/i) || [])[1];
    if (!name) continue;
    const type = ((tag.match(/\btype="([^"]+)"/i) || [])[1] || 'text').toLowerCase();
    const value = decodeHtml((tag.match(/\bvalue="([^"]*)"/i) || [])[1] ?? '');
    // Keep hidden values verbatim; remember other fields so we can fill them.
    if (type === 'hidden' || value) fields[name] = value;
    else if (!(name in fields)) fields[name] = '';
  }
  return { fields, action: decodeHtml(action) };
}

// Finds the real field name for a logical one (AO3 uses user[login] etc.).
function findField(fields, ...candidates) {
  const names = Object.keys(fields);
  for (const c of candidates) {
    const exact = names.find(n => n.toLowerCase() === c.toLowerCase());
    if (exact) return exact;
  }
  for (const c of candidates) {
    const loose = names.find(n => n.toLowerCase().includes(c.toLowerCase()));
    if (loose) return loose;
  }
  return null;
}

/**
 * Loads the signup form for an invitation token. AO3 has used more than one URL
 * shape for this over the years, so we try each and use whichever responds with
 * an actual form instead of assuming one and failing with a bare 404.
 */
export async function getSignupForm(token) {
  const tk = encodeURIComponent(token);
  const candidates = [
    `/signup/${tk}`,
    `/users/new?invitation_token=${tk}`,
    `/invitations/${tk}/signup`,
    `/invitations/${tk}`,
  ];

  let lastStatus = null;
  for (const path of candidates) {
    let html;
    try {
      html = await ky.get(BASE + path, { headers: BROWSER_HEADERS }).text();
    } catch (e) {
      lastStatus = e?.response?.status ?? lastStatus;
      continue; // 404 on this shape — try the next
    }

    if (/invitation.{0,60}(invalid|already been used|not found|expired)/i.test(html)) {
      throw new Error('This invitation link is invalid, expired, or already used.');
    }
    const { fields, action } = parseFormFields(html);
    const hasLogin = !!findField(fields, 'user[login]', 'login');
    if (!hasLogin) continue; // not the sign-up form — keep looking

    if (!fields.authenticity_token) {
      fields.authenticity_token = extractAuthenticityToken(html);
    }
    return { fields, action, referer: BASE + path };
  }

  if (lastStatus === 404) {
    throw new Error(
      'AO3 did not recognise this invitation link (404). Make sure you copied the full link from the invitation email.',
    );
  }
  throw new Error(
    'Could not open the sign-up form. The invitation may be invalid or AO3 may be blocking the request.',
  );
}

/**
 * Opens AO3's official sign-up page in a WebView. Accepts the full
 * invitation URL from AO3's email (preferred) or a bare token. The user
 * completes the sign-up form on the official page — age/terms checkboxes
 * and password rules are validated there, no client-side replay.
 */
export async function registerAccount(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Paste the invitation link from your email.');
  let url;
  if (/^[A-Za-z0-9_-]+$/.test(s)) {
    url = 'https://archiveofourown.org/signup/' + encodeURIComponent(s);
  } else {
    url = s.startsWith('http') ? s : 'https://archiveofourown.org' + (s.startsWith('/') ? s : '/' + s);
  }
  await completeInOfficialPage(url);
  return 'Account created. Check your email for the activation link.';
}

/**
 * Finishes registration by opening the activation link from AO3's email
 * in a WebView. Accepts the full URL (or just its path).
 */
export async function activateAccount(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Paste the activation link from your email.');
  let url;
  if (s.startsWith('http')) {
    url = s;
  } else {
    url = 'https://archiveofourown.org' + (s.startsWith('/') ? s : '/' + s);
  }
  await completeInOfficialPage(url);
  return 'Activation link opened. Try logging in now.';
}

/**
 * Requests an AO3 invitation for `email`.
 * Resolves with a message to show the user; rejects with AO3's error text.
 */
export async function requestInvitation(email) {
  if (!email || !email.trim()) throw new Error('Enter your email address.');
  let token;
  try {
    ({ token } = await getForm('/invite_requests'));
  } catch (error) {
    if (error?.response?.status === 404) throw invitationPageError();
    throw error;
  }
  const { res, html } = await postForm(
    '/invite_requests',
    {
      authenticity_token: token,
      'invite_request[email]': email.trim(),
      commit: 'Add me to the list!',
    },
    BASE + '/invite_requests',
  );

  const outcome = readOutcome(html);
  if (outcome) {
    if (!outcome.ok) throw new Error(outcome.message);
    return {
      message: outcome.message,
      queue: await getInvitationQueueInfo(email),
    };
  }
  if (res.ok || res.redirected) {
    return {
      message: 'Your invitation request has been submitted.',
      queue: await getInvitationQueueInfo(email),
    };
  }
  throw new Error(`Request failed (HTTP ${res.status}).`);
}
