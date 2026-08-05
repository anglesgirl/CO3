import getUrl from '../requestManager';
import { echUrl } from '../echKy';

let DomParser = require('react-native-html-parser').DOMParser;

async function scrapeUserPage(url, username) {
  const res = await getUrl(url);

  const doc = new DomParser().parseFromString(res, "text/html");
  // 头像必须在 #main 主体内找：页面 header 里当前登录用户自己的头像
  // 也是 class="icon" 且 DOM 顺序靠前，全文档取第一个会拿到"自己"的头像。
  // （AO3 登录态下 header 头像在 #main 之外，限定作用域即可避开。）
  const mainScope = doc.getElementById("main") || doc;
  const avatar = Array.from(mainScope.getElementsByTagName("img")).filter(img => img?.getAttribute("class") === "icon")[0];
  const bio = Array.from(doc.getElementsByTagName("blockquote"))
    .filter(a => a.getAttribute("class") === `userstuff` && a.parentNode.getAttribute("id") !== "admin-banner")[0];

  const meta = Array.from(doc.getElementsByTagName("dl"))
    .filter(a => a.getAttribute("class") === `meta`)[0];
  console.log(meta);
  const joinDate = meta?.childNodes[7]?.textContent;

  console.log(avatar);

  const avatarPath = avatar?.getAttribute('src');
  const avatarUrl = avatarPath
    ? await echUrl(new URL(avatarPath, 'https://archiveofourown.org').href)
    : null;

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
