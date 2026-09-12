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

/**
 * 去标签、还原 JS 转义、**解码 HTML 实体**。
 *
 * ⚠️ **不要删 `<script>…</script>` 里的内容** —— 这个接口的响应**本身就是**
 * Rails 的 js.erb 片段（形如 `$("#x").html("…")`），删 script 等于把要解析的正文
 * 整段扔掉，结果是"永远解析不到任何结果"（回归测试里暴露过）。
 *
 * ⚠️ **必须解码实体**：真机抓到的原始响应是
 *   `$("#invite-status").html("<p class=\"notice\">\n  Sorry, we can&#39;t find the email address you entered.\n<\/p>\n");`
 * 撇号是 `&#39;` 而不是 `'` —— 不解码的话，正则 `can'?t find` **匹配不到**，
 * "未登记"会被误判成"解析不出结果"。同理要处理 JS 转义的 `\/` 和 `\"`。
 */
function flatten(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n|\\r|\\t/g, ' ')
    // HTML 实体：数字实体（&#39; / &#x27;）+ 常见命名实体
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
  // ⚠️ 这里**不能放"看着像名次"的宽匹配**（例如 `>123<`）——
  // 用户提供的两份真机 HAR 对比：已登记的响应 1058 字节、**未登记的只有 121 字节**，
  // 而后者里同样会出现数字，宽正则会把"没排队的人"解析出一个**假名次**。
  // 只认明确的语义句；同时把"明确没找到"的情况单独判出来（见 notFound）。
  const position =
    (flat.match(/you are (?:currently )?(?:number|position|in position)\s*#?\s*([\d,]+)/i) || [])[1] ||
    (flat.match(/your position is\s*#?\s*([\d,]+)/i) || [])[1] ||
    (flat.match(/there are\s+([\d,]+)\s+people (?:ahead of you|before you)/i) || [])[1] ||
    null;

  // 真机抓到的原文（未登记邮箱的响应，只有 121 字节）：
  //   "Sorry, we can&#39;t find the email address you entered."
  // （实体已在 flatten 里解码，所以这里按真实字符写正则）
  const notFound =
    /sorry,?\s*we\s+can'?t\s+find|can'?t\s+find\s+the\s+email|no (?:invitation )?request (?:was )?found|not (?:currently )?(?:on|in) the (?:waiting )?list|doesn'?t (?:appear|seem) to be/i.test(
      flat,
    );

  const total =
    (flat.match(/There are currently\s+([\d,]+)\s+people on the waiting list/i) || [])[1] ||
    (flat.match(/There are\s+([\d,]+)\s+people\s+(?:in|on)\s+the\s+(?:queue|waiting list)/i) || [])[1] ||
    null;

  const rateM = flat.match(/sending out\s+([\d,]+)\s+invitations every\s+(\d+)\s+hours/i);
  const rate = rateM ? `${rateM[1]} / ${rateM[2]}h` : null;

  const inQueue =
    !!position ||
    (!notFound &&
      (/already (?:on|in) the (?:list|queue)/i.test(flat) ||
        /you (?:are|'re) (?:on|in) the (?:waiting )?list/i.test(flat)));

  return {
    ok: status >= 200 && status < 400,
    inQueue,
    notFound,
    position,
    total,
    rate,
    // 解析不到时把片段带回去 —— 方便定位"是不是 AO3 又改了措辞"
    raw: flat.slice(0, 500),
    message: status >= 200 && status < 400 ? 'ok' : `http_${status}`,
  };
}
