import AsyncStorage from '@react-native-async-storage/async-storage';
import getUrl from '../requestManager';

/**
 * 应用内提交「申请邀请」（加入排队）。
 *
 * ⚠️ **本模块的重点不是"能提交"，而是"不许滥用"。**
 * 用户原话："提交被繁忙以后，直接帮官方暂停，需要等至少5分钟以后再提交，
 * 要不然我们就成了攻击官方的工具了。"
 *
 * AO3 是志愿者运营的非营利站点，排队常年 27 万+ 人，申请页高峰本身就返回"繁忙"。
 * 客户端若自动重试，就等于把用户变成 DDoS 的一部分 —— 所以这里强制三条红线：
 *
 *  1. **一次操作只发一个请求**，任何失败都不自动重试；
 *  2. **被"繁忙"拒绝后进入 5 分钟冷却**，并且**持久化**（重启 app 也不能绕过）；
 *  3. **失败就是失败**，如实告诉用户，何时再试由人决定 —— app 不替用户做决定。
 *
 * 另外：成功提交后同样进入冷却，避免"换个邮箱接着提交"式的连击。
 */

const AO3 = 'https://archiveofourown.org';
const COOLDOWN_KEY = 'invite_request_cooldown_until';

/** 被繁忙拒绝后的暂停时长（用户指定：至少 5 分钟）。 */
export const BUSY_COOLDOWN_MS = 5 * 60 * 1000;
/** 成功后的暂停时长：一次一个就够了，避免连续替多个邮箱提交。 */
export const SUCCESS_COOLDOWN_MS = 5 * 60 * 1000;

/** 冷却剩余毫秒（0 表示可以提交）。冷却写在本地存储里，重启也绕不过。 */
export async function getCooldownLeft() {
  try {
    const until = Number(await AsyncStorage.getItem(COOLDOWN_KEY)) || 0;
    const left = until - Date.now();
    return left > 0 ? left : 0;
  } catch {
    return 0;
  }
}

async function startCooldown(ms) {
  try {
    await AsyncStorage.setItem(COOLDOWN_KEY, String(Date.now() + ms));
  } catch {
    /* 存储失败也不能让用户留在"可以立刻再试"的状态：内存里没有别的依据，
       所以宁可失败也不放行 —— 调用方会按 busy 处理结果。 */
  }
}

/**
 * 判断是否应视为"官方繁忙"。
 * 宁可判宽一点：把模糊的失败也当作 busy 并冷却，比"猜对了没繁忙"更安全 ——
 * 判错方向的代价是用户多等 5 分钟，而不是给官方加压。
 */
function looksBusy(status, text) {
  if (status === 429 || status === 503 || status === 502 || status === 520) return true;
  return /busy|too many requests|try again later|rate limit|service unavailable|please wait|overloaded/i.test(
    String(text || ''),
  );
}

/** 去标签 + 解码实体（与排队查询同一套处理）。 */
function flatten(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n|\\r|\\t/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 提取申请表单（token / action / 邮箱字段名）。
 * **字段名一律从页面实际表单读取，不写死** —— 之前照页面猜字段名吃过亏
 * （排队查询那次的字段名/方法/路径全错），所以这里坚持"以页面为准"。
 */
export async function fetchInviteRequestForm() {
  try {
    const html = await getUrl(`${AO3}/invite_requests`, false);
    const text = String(html || '');
    const forms = text.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
    const raw =
      forms.find((s) => /invite|email/i.test(s) && /post/i.test(s)) ||
      forms.find((s) => /invite|email/i.test(s)) ||
      '';
    if (!raw) return { ok: false, message: 'no_form' };

    const action = (raw.match(/action="([^"]*)"/i) || [])[1] || '/invite_requests';
    const token = (raw.match(/name="authenticity_token"[^>]*value="([^"]+)"/i) || [])[1] || '';
    const emailField =
      (raw.match(/<input[^>]*name="([^"]*email[^"]*)"[^>]*>/i) || [])[1] ||
      (raw.match(/<input[^>]*type="(?:text|email)"[^>]*name="([^"]+)"/i) || [])[1] ||
      '';
    if (!token || !emailField) return { ok: false, message: 'no_fields' };
    return { ok: true, action, token, emailField };
  } catch (e) {
    return { ok: false, message: `net_${e.message}` };
  }
}

/**
 * 提交申请。**只发一次请求，绝不自动重试。**
 * @returns {{ ok: boolean, message: string, waitMs?: number, detail?: string }}
 */
export async function submitInviteRequest(email) {
  const clean = String(email || '').trim();
  if (!clean || !clean.includes('@')) return { ok: false, message: 'email_invalid' };

  // 红线②：冷却期内直接拒绝，连请求都不发
  const left = await getCooldownLeft();
  if (left > 0) return { ok: false, message: 'cooldown', waitMs: left };

  const form = await fetchInviteRequestForm();
  if (!form.ok) return { ok: false, message: form.message };

  const url = form.action.startsWith('http') ? form.action : `${AO3}${form.action}`;
  const params = new URLSearchParams();
  params.append('authenticity_token', form.token);
  params.append(form.emailField, clean);
  params.append('commit', 'Request an invitation');

  let status = 0;
  let text = '';
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
        Referer: `${AO3}/invite_requests`,
      },
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    // 网络层失败不当作"繁忙"（可能是本地网络问题），但也**不重试**
    return { ok: false, message: `net_${e.message}` };
  }

  // 红线②：繁忙 → 立刻自我暂停
  if (looksBusy(status, text)) {
    await startCooldown(BUSY_COOLDOWN_MS);
    return { ok: false, message: 'busy', waitMs: BUSY_COOLDOWN_MS };
  }

  const flat = flatten(text);
  if (/already (?:requested|on|in)|you are (?:already )?on the waiting list|invitation was emailed/i.test(flat)) {
    await startCooldown(SUCCESS_COOLDOWN_MS);
    return { ok: true, message: 'already' };
  }
  if (/request (?:has been )?received|added to the waiting list|we'll email you|check your email/i.test(flat)) {
    await startCooldown(SUCCESS_COOLDOWN_MS);
    return { ok: true, message: 'submitted' };
  }

  // 其余情况**不谎报成功**：把可见的错误文案带回去，并同样进入冷却
  //（因为它很可能也是一种限流/校验拒绝，紧接着再试没有意义）。
  const err = (flat.match(/(?:error|notice)[^.]{0,160}/i) || [])[0] || '';
  await startCooldown(BUSY_COOLDOWN_MS);
  return { ok: false, message: 'rejected', detail: err ? err.trim() : undefined, waitMs: BUSY_COOLDOWN_MS };
}
