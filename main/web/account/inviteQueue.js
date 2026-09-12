/**
 * 查询邀请排队名次。
 *
 * 【真实请求（用户提供的真机 DevTools HAR，实测）】
 *   GET /invite_requests/show?email=<邮箱>&email=<邮箱>&commit=Look+me+up
 *   Accept: * / *;q=0.5, text/javascript, application/javascript, ...
 *   Referer:      https://archiveofourown.org/invite_requests/status
 *   X-Requested-With: XMLHttpRequest
 *   → 200，content-type: text/javascript
 *     （Rails 的 remote form，返回的是 js.erb 片段，不是整页 HTML）
 *
 * 【为什么推翻了上一版实现】
 * 上一版是 **照 /invite_requests 页面上的表单猜的**：
 *   POST /invite_requests + invite_request[email] + authenticity_token
 * 方法、路径、字段名**全都不对** —— 典型反面教材：
 *   - GET 查询根本不需要 CSRF token（多带无意义）；
 *   - 路径应是 `/invite_requests/show`（`/invite_requests` 只是展示页）；
 *   - 真正被接受的参数名是 `email`，不是 `invite_request[email]`。
 * **能抓到真实请求就不要照页面猜** —— 猜错的表现是"接口一直返回不了名次"，
 * 而且看起来像服务端抽风，极难自查。
 *
 * 【细节】
 *  1. `email` 要**重复传两次**（真机抓包如此，Rails 的 form_tag 参数 + 表单字段同名）；
 *  2. 必须带 `X-Requested-With: XMLHttpRequest` 与 `Referer`：
 *     Rails 的 respond_to 靠它决定返回 JS 还是 HTML；
 *  3. **不在排队中的邮箱没有名次** —— 取不到位置不等于出错，按"未在排队"处理。
 */

const AO3 = 'https://archiveofourown.org';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** 去标签，方便在 JS 片段/HTML 里做宽松匹配。 */
function flatten(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\n|\\r|\\t/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 查询某个邮箱在邀请队列中的位置。
 * @returns {{ ok: boolean, inQueue: boolean, position: string|null, total: string|null,
 *             rate: string|null, raw: string, message: string }}
 */
export async function queryInviteQueue(email) {
  const clean = String(email || '').trim();
  if (!clean || !clean.includes('@')) {
    return { ok: false, inQueue: false, position: null, total: null, rate: null, raw: '', message: 'email_invalid' };
  }

  const q = encodeURIComponent(clean);
  // email 故意传两次 —— 与真机抓包一致
  const url = `${AO3}/invite_requests/show?email=${q}&email=${q}&commit=Look+me+up`;

  let text = '';
  let status = 0;
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: '*/*;q=0.5, text/javascript, application/javascript, application/ecmascript, application/x-ecmascript',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: `${AO3}/invite_requests/status`,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
      },
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    return { ok: false, inQueue: false, position: null, total: null, rate: null, raw: '', message: `net_${e.message}` };
  }

  const flat = flatten(text);

  // 名次：AO3 措辞变过多次，做宽松匹配，并兼容 JS 片段里的数字
  const position =
    (flat.match(/you are (?:currently )?(?:number|position|in position)\s*#?\s*([\d,]+)/i) || [])[1] ||
    (flat.match(/your position is\s*#?\s*([\d,]+)/i) || [])[1] ||
    (flat.match(/there are\s+([\d,]+)\s+people (?:ahead of you|before you)/i) || [])[1] ||
    (flat.match(/>\s*#?([\d,]+)\s*</) || [])[1] ||
    null;

  const total =
    (flat.match(/There are currently\s+([\d,]+)\s+people on the waiting list/i) || [])[1] ||
    (flat.match(/There are\s+([\d,]+)\s+people\s+(?:in|on)\s+the\s+(?:queue|waiting list)/i) || [])[1] ||
    null;

  const rateM = flat.match(/sending out\s+([\d,]+)\s+invitations every\s+(\d+)\s+hours/i);
  const rate = rateM ? `${rateM[1]} / ${rateM[2]}h` : null;

  const inQueue =
    !!position ||
    /already (?:on|in) the (?:list|queue)/i.test(flat) ||
    /you (?:are|'re) (?:on|in) the (?:waiting )?list/i.test(flat);

  return {
    ok: status >= 200 && status < 400,
    inQueue,
    position,
    total,
    rate,
    // 解析不到时把片段带回去 —— 方便定位"是不是 AO3 又改了措辞"
    raw: flat.slice(0, 500),
    message: status >= 200 && status < 400 ? 'ok' : `http_${status}`,
  };
}
