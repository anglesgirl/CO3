import getUrl from '../requestManager';

/**
 * 应用内完成「用邀请链接注册」和「激活账号」。
 *
 * 用户要求："不走网页模式，而是app本体，这样没那么大割裂感。"
 * —— 所以这两处不再 `openEchBrowser(...)` 甩给 WebView，而是在应用内直接完成，
 *    失败时给出可读的原因（而不是把用户丢进一个空白网页）。
 *
 * 【字段名一律从页面实际表单提取，不写死】
 * AO3 改过表单结构（登录/重置密码都出现过"字段名过时→提交被静默忽略"），
 * 所以注册表单的所有 input 都按页面真实内容动态生成，token/action 同理。
 */

export const AO3 = 'https://archiveofourown.org';

/** 从一段 HTML 里提取第一个匹配表单的关键信息。 */
function parseForm(html, hintRe) {
  const forms = String(html || '').match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
  const raw = forms.find((s) => hintRe.test(s)) || forms[0] || '';
  const action = (raw.match(/action="([^"]*)"/i) || [])[1] || '';
  const token = (raw.match(/name="authenticity_token"[^>]*value="([^"]+)"/i) || [])[1] || '';
  const challenge = (raw.match(/name="cf_challenge_response"[^>]*value="([^"]+)"/i) || [])[1] || '';

  // 所有可填字段（跳过 token / submit / button）
  const fields = [];
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(raw))) {
    const tag = m[0];
    const name = (tag.match(/name="([^"]+)"/i) || [])[1];
    if (!name) continue;
    if (/authenticity_token|cf_challenge_response|^commit$|^utf8$/i.test(name)) continue;
    const type = ((tag.match(/type="([^"]+)"/i) || [])[1] || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'hidden' || type === 'checkbox') continue;
    const label =
      (tag.match(/placeholder="([^"]*)"/i) || [])[1] ||
      (tag.match(/aria-label="([^"]*)"/i) || [])[1] ||
      name.replace(/^user\[|\]$/g, '');
    fields.push({ name, type: type === 'password' ? 'password' : 'text', label });
  }
  return { action, token, challenge, fields, raw };
}

/** 激活链接：访问即生效（GET），不需要窗体。 */
export async function activateByLink(link) {
  const url = String(link || '').trim();
  if (!/archiveofourown\.org/.test(url)) return { ok: false, message: 'bad_link' };
  try {
    const html = await getUrl(url, false);
    const text = String(html || '');
    if (/have been successfully activated|activated your account|Your account has been activated/i.test(text)) {
      return { ok: true, message: 'activated' };
    }
    if (/already (been )?activated/i.test(text)) return { ok: true, message: 'already' };
    if (/invalid|expired|not found/i.test(text)) return { ok: false, message: 'invalid' };
    // 没拿到明确文案时，不谎报成功
    return { ok: false, message: 'unclear' };
  } catch (e) {
    return { ok: false, message: `net_${e.message}` };
  }
}

/** 拉取注册页，返回可动态渲染的字段列表（应用内自建窗体用）。 */
export async function fetchRegisterForm(inviteToken) {
  const url = `${AO3}/users/new?invitation_token=${encodeURIComponent(inviteToken)}`;
  try {
    const html = await getUrl(url, false);
    const text = String(html || '');
    if (/invitation token.*(invalid|used|expired)/i.test(text)) {
      return { ok: false, message: 'bad_token' };
    }
    const form = parseForm(text, /users|sign|register|new_user/i);
    if (!form.token) return { ok: false, message: 'no_token' };
    return { ok: true, action: form.action, token: form.token, fields: form.fields };
  } catch (e) {
    return { ok: false, message: `net_${e.message}` };
  }
}

/** 提交注册（应用内 POST，urlencoded —— multipart 会被 AO3 静默丢弃）。 */
export async function submitRegister({ action, token, fields, values }) {
  const url = action ? (action.startsWith('http') ? action : `${AO3}${action}`) : `${AO3}/users`;
  const params = new URLSearchParams();
  params.append('authenticity_token', token);
  Object.entries(values || {}).forEach(([k, v]) => params.append(k, String(v)));
  params.append('commit', 'Create Account');

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: params.toString(),
      credentials: 'include',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Origin: AO3,
        Referer: `${AO3}/users/new`,
      },
    });
    const text = await res.text();
    if (res.status === 302 && /\/users\/confirmation|welcome|dashboard/i.test(text)) {
      return { ok: true, message: 'created' };
    }
    // 表单校验失败：把第一条错误文案带回去，用户能知道是哪里不对（用户名被占用等）
    const err = (text.match(/<div[^>]*class="[^"]*error[^"]*"[^>]*>([\s\S]{0,200}?)<\/div>/i) || [])[1];
    const clean = err ? err.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    if (res.ok && !clean) return { ok: true, message: 'created' };
    return { ok: false, message: 'rejected', detail: clean };
  } catch (e) {
    return { ok: false, message: `net_${e.message}` };
  }
}
