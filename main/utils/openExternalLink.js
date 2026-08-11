// openExternalLink — 统一的"打开链接"入口。
//
// 背景（2026-08-11）：chapterReader 里点正文链接直接 Linking.openURL()，
// 会把 AO3 链接丢给系统浏览器。系统浏览器是独立进程，**用不到 App 内的
// ECH 代理**，在 DNS 被污染的网络里必然打不开（页面转圈/连接重置）。
//
// 规则：
//   * AO3 域名 → 交给 App 内的 WebView（走 ECH 代理），由调用方决定是
//     打开内嵌浏览器还是路由到 App 内页面；这里返回 { handled:false, ao3:true }
//     让调用方处理，避免本模块反向依赖导航。
//   * 其它域名 → Linking.openURL（这些站点没被墙，外部浏览器正常）。
//
// 之所以不"把系统浏览器也代理起来"：进程隔离，除非在设备上装 VPN/系统
// 代理，App 无法让外部浏览器走自己的本地端口。

import { Linking } from 'react-native';

export const AO3_HOSTS = new Set([
  'archiveofourown.org',
  'www.archiveofourown.org',
  'download.archiveofourown.org',
]);

export function isAo3Url(url) {
  try {
    return AO3_HOSTS.has(new URL(String(url)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 打开一个链接。
 * @returns {Promise<{opened: boolean, ao3: boolean}>}
 *   ao3=true 表示这是 AO3 链接，调用方应该用内嵌 WebView / App 内页面打开
 *   （因为外部浏览器没有 ECH 代理），此时 opened=false。
 */
export async function openExternalLink(url) {
  const target = String(url || '').trim();
  if (!target) return { opened: false, ao3: false };

  if (isAo3Url(target)) {
    return { opened: false, ao3: true };
  }

  await Linking.openURL(target);
  return { opened: true, ao3: false };
}
