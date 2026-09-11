import getUrl from '../requestManager';

let DomParser = require('react-native-html-parser').DOMParser;

async function scrapeUserPage(url, username) {
  const res = await getUrl(url);

  const doc = new DomParser().parseFromString(res, "text/html");

  // 【头像必须限定在 #main 内 —— 老 bug 的根因】
  // 已登录时，页面顶栏（位于 #main 之外）也含一个 <img class="icon">，那是**观看者自己的头像**，
  // 且 DOM 顺序排在作者头像之前。所以"全页面取第一个 class=icon 的 img"会让每个作者主页
  // 都显示成登录用户自己的头像。
  // 实测（登录态抓 /users/astolat/profile）：全页 2 个 class=icon 的 img，
  //   第 0 个 alt=""（顶栏自己的）、第 1 个 alt="the lady of shalott weaving"（作者本人）；
  //   #main 内只有 1 个，正是作者头像。
  // 因此两道保险：①只在 #main 内找；②排除 alt 为空的那个（顶栏头像 alt 恒为空）。
  // 【不再要求 alt 非空 —— 那会漏掉"没设置头像"的作者】
  // 没设置头像时 AO3 会给一张默认图，它的 alt 可能为空；
  // 原实现用 `cls.includes("icon") && !!alt` 过滤，会把这类作者的头像整批丢掉，
  // 表现为"作者头像不显示"（用户实测反馈：没设置也应该有默认头像）。
  // 顶栏那个"观看者自己的头像"在 #main 之外，靠上面的 scope 已经排除，不必再用 alt 区分。
  // 实测 /users/astolat/profile：#main 内 class=icon 的 img 恰好 1 个（作者本人）。
  const scope = doc.getElementById("main") || doc;
  const iconImgs = Array.from(scope.getElementsByTagName("img") || []);
  const avatar = iconImgs.filter(img => {
    const cls = (img && typeof img.getAttribute === 'function' ? img.getAttribute("class") : "") || "";
    return cls.split(/\s+/).includes("icon");
  })[0] || null;

  // bio：限定 #main，并排除全局公告（admin-banner）
  const bio = Array.from(scope.getElementsByTagName("blockquote") || [])
    .filter(a => {
      const cls = a.getAttribute("class") || "";
      const parentId = a.parentNode ? a.parentNode.getAttribute("id") : null;
      return cls === "userstuff" && parentId !== "admin-banner";
    })[0] || null;

  const meta = Array.from(scope.getElementsByTagName("dl") || [])
    .filter(a => a.getAttribute("class") === "meta")[0];

  // joinDate：原来用 meta.childNodes[7]（固定下标，页面加一个字段就错位）。
  // 改为按 <dt>Joined:</dt> 找它后面的 <dd>。
  let joinDate = null;
  if (meta && meta.childNodes) {
    const nodes = Array.from(meta.childNodes);
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      const text = (n && n.textContent) ? String(n.textContent).trim() : "";
      if (/^joined/i.test(text)) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const cand = nodes[j];
          const candText = (cand && cand.textContent) ? String(cand.textContent).trim() : "";
          if (candText) {
            joinDate = candText;
            break;
          }
        }
        break;
      }
    }
  }

  let avatarUrl = avatar && typeof avatar.getAttribute === 'function'
    ? avatar.getAttribute("src")
    : null;

  // 相对路径补全（解析器里不会自动 resolve），默认头像也补全域名
  if (avatarUrl && avatarUrl.startsWith("/")) {
    avatarUrl = `https://archiveofourown.org${avatarUrl}`;
  }

  return {
    username: username,
    avatarUrl: avatarUrl,
    bio: bio,
    joinDate: joinDate,
  };
}

export async function getUserInfo(username) {
  const url = `https://archiveofourown.org/users/${username}/profile`;
  return scrapeUserPage(url, username);
}

export async function getUserInfoByPseud(username, pseud) {
  const url = `https://archiveofourown.org/users/${username}/pseuds/${encodeURIComponent(pseud)}`;
  return scrapeUserPage(url, username);
}
