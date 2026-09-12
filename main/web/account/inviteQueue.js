import getUrl from '../requestManager';

/**
 * 查询邀请排队名次。
 *
 * AO3 的做法（服务器实测页面结构得到，不是猜的）：
 *   在 /invite_requests 上有一个表单
 *     action="/invite_requests" method="post"
 *     字段 invite_request[email]
 *   提交邮箱后由服务器返回"你当前排第几"。
 *   **不在排队中的邮箱不会有名次** —— 这是用户明确说明的，
 *   所以取不到位置时不能当成错误，要按"未在排队"处理。
 *
 * 三个必须遵守的细节：
 *  1. **必须 urlencoded**：`FormData` 会被 RN 发成 multipart，而 AO3 只认
 *     `application/x-www-form-urlencoded`（登录那次就是栽在这个坑上）。
 *  2. **必须带 Origin / Referer**：缺了会被 CSRF 保护拦成 403（服务器侧实测）。
 *  3. **Cookie 不要手写**：由 OkHttp 的 cookieJar（CookieManager）自动注入，
 *     手写反而会拿旧值覆盖正确 cookie。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const PAGE = 'https://archiveofourown.org/invite_requests';

/**
 * 查询某个邮箱在邀请队列中的位置。
 * @returns {{ ok: boolean, inQueue: boolean, position: string|null, total: string|null,
 *             rate: string|null, raw: string, message: string }}
 */
export async function queryInviteQueue(email) {
  if (!email || !String(email).includes('@')) {
    return { ok: false, inQueue: false, position: null, total: null, rate: null, raw: '', message: 'email_invalid' };
  }

  // 1) 先取页面拿 authenticity_token（POST 必带，缺了会被拒）
  const page = await getUrl(PAGE, false);
  const tokenMatch = String(page || '').match(/name="authenticity_token"\s+value="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : null;
  if (!token) {
    return { ok: false, inQueue: false, position: null, total: null, rate: null, raw: '', message: 'no_token' };
  }

  // 2) 提交查询
  const params = new URLSearchParams();
  params.append('authenticity_token', token);
  params.append('invite_request[email]', String(email).trim());
  params.append('commit', 'Add me to the list');

  const res = await fetch(PAGE, {
    method: 'POST',
    body: params.toString(),
    credentials: 'include',
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

  // 3) 解析（措辞随 AO3 版本变过，做宽松匹配；取不到就把原文关键句带回去供排查）
  const position =
    (text.match(/you are (?:currently )?(?:number|position)\s*#?\s*([\d,]+)/i) || [])[1] ||
    (text.match(/your position is\s*#?\s*([\d,]+)/i) || [])[1] ||
    (text.match(/there are\s+([\d,]+)\s+people (?:ahead of you|before you)/i) || [])[1] ||
    null;

  const total =
    (text.match(/There are currently\s+([\d,]+)\s+people on the waiting list/i) || [])[1] ||
    (text.match(/There are\s+([\d,]+)\s+people\s+(?:in|on)\s+the\s+(?:queue|waiting list)/i) || [])[1] ||
    null;

  const rateM = text.match(/sending out\s+([\d,]+)\s+invitations every\s+(\d+)\s+hours/i);
  const rate = rateM ? `${rateM[1]} / ${rateM[2]}h` : null;

  return {
    ok: res.ok,
    inQueue: !!position || /already (?:on|in) the (?:list|queue)/i.test(text),
    position,
    total,
    rate,
    raw: String(text).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
    message: res.ok ? 'ok' : `http_${res.status}`,
  };
}
