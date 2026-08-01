/**
 * Cloudflare Worker: PostHog 反向代理
 *
 * 作用:把 App 的统计请求转发到 PostHog 官方,隐藏 posthog 域名,
 * 绕过广告拦截器(拦截器会屏蔽 us.i.posthog.com,但不会屏蔽你自己的子域)。
 *
 * 部署步骤(约 5 分钟):
 * 1. Cloudflare 控制台 → Workers & Pages → Create → Worker,粘贴本文件内容。
 * 2. 触发器 → Custom Domains → 绑定一个子域,例如 e.anglesya.win。
 * 3. 在 App 的 main/constant.js 里把 POSTHOG_HOST 改成:
 *      export const POSTHOG_HOST = 'https://e.anglesya.win';
 * 4. 重新构建 App 即可。以后想换回直连或换域名,只改这一行。
 *
 * 选 US 或 EU 区域:取决于你 PostHog 账号所在区域(注册时选的)。
 * 美国用户多就保持 us,欧洲就改成 eu。
 *
 * 注意:此代理只改传输路径,不改变 PostHog 采集的数据内容。
 */

// 按你的 PostHog 区域二选一:
const API_HOST = 'us.i.posthog.com';
const ASSET_HOST = 'us-assets.i.posthog.com';
// 欧洲区域改为:
// const API_HOST = 'eu.i.posthog.com';
// const ASSET_HOST = 'eu-assets.i.posthog.com';

async function handleRequest(request, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const search = url.search;
  const pathWithParams = pathname + search;

  // 静态资源(SDK 资源)走缓存
  if (pathname.startsWith('/static/') || pathname.startsWith('/array/')) {
    return retrieveAsset(request, pathWithParams, ctx);
  }
  return forwardRequest(request, pathWithParams);
}

async function retrieveAsset(request, pathname, ctx) {
  let response = await caches.default.match(request);
  if (!response) {
    response = await fetch(`https://${ASSET_HOST}${pathname}`);
    ctx.waitUntil(caches.default.put(request, response.clone()));
  }
  return response;
}

async function forwardRequest(request, pathWithSearch) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const originHeaders = new Headers(request.headers);
  originHeaders.delete('cookie');
  originHeaders.set('X-Forwarded-For', ip);

  const originRequest = new Request(`https://${API_HOST}${pathWithSearch}`, {
    method: request.method,
    headers: originHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD'
      ? await request.arrayBuffer()
      : null,
    redirect: request.redirect,
  });
  return await fetch(originRequest);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, ctx);
  },
};
