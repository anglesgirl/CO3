import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import WebView from 'react-native-webview';
import CookieManager from '@react-native-cookies/cookies';
import { useTranslation } from 'react-i18next';
import { getEchBase, getJarInfo } from './echKy';

// 需要走本地 ECH 代理的域名：
// - AO3 主域：被墙，必须走代理（fail-closed）
// - challenges.cloudflare.com：未被墙但直连极慢（CF 国际线路绕路），
//   走代理用 DoH 优选 IP + ECH 直连反而更快；且其验证回调若直连
//   仍可能受 DNS 污染干扰，统一走代理最稳。
const PROXIED_HOSTS = new Set([
  'archiveofourown.org',
  'www.archiveofourown.org',
  'challenges.cloudflare.com',
]);

/**
 * 如果 ECH 代理可用，把需要走代理的域名改写为本地代理 URL，
 * 这样 WebView 也不裸连目标域（AO3 被墙重置 -6，CF 直连极慢）。
 *
 * 2026-08-06 修正：AO3 域名在代理不可用时**直接抛错**（fail-closed），
 * 不再静默直连——国内用户没有系统 DoH 时直连必失败（DNS 污染），
 * 静默直连只会造成"看起来能打开其实半残"的假象。非 AO3 域名
 * （图片/静态资源等）仍允许直连。
 */
async function rewriteForEch(url) {
  try {
    const base = await getEchBase();
    const u = new URL(url);
    if (PROXIED_HOSTS.has(u.hostname)) {
      if (!base) {
        if (u.hostname === 'challenges.cloudflare.com') {
          // CF 验证域直连虽慢但能通（未被墙），代理不可用时降级直连，
          // 否则 challenge 窗口直接打不开，登录必死。
          console.log(`[WV] ECH proxy unavailable, direct-loading ${u.hostname} (slow but not blocked)`);
          return { uri: url, headers: undefined };
        }
        console.log(`[WV] ECH proxy unavailable, refusing direct WebView load of ${u.hostname}`);
        throw new Error('ECH proxy unavailable; refusing direct WebView request');
      }
      return {
        uri: base + u.pathname + u.search,
        headers: { 'X-Ech-Target': u.hostname },
      };
    }
    return { uri: url, headers: undefined };
  } catch (error) {
    if (error instanceof TypeError) {
      // URL parse failure: not a valid URL at all, let the caller handle it.
      return { uri: url, headers: undefined };
    }
    throw error;
  }
}

// --- Queue ---

const queue = [];
let triggerNext = null;

function enqueue(item) {
  queue.push(item);
  triggerNext?.();
}

export function fetchViaWebView(url, { cfWarning = false, requireLoginForm = false, preVerify = false, interactiveLogin = false, direct = false, html = null, baseUrl = null } = {}) {
  return new Promise((resolve, reject) =>
    enqueue({ url, resolve, reject, cfWarning, requireLoginForm, preVerify, interactiveLogin, direct, html, baseUrl }),
  );
}

// --- Error ---

export class WebViewFetchError extends Error {
  constructor(status, statusText, url) {
    super(`${status} ${statusText}`);
    this.name = 'WebViewFetchError';
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.response = { status, statusText, url };
  }
}

// --- CF detection ---

// 反钓鱼绕过（interactiveLogin 模式注入）：WebView 页面 URL 是本地代理
// 地址 http://127.0.0.1:<port>/...，AO3 前端 JS 检测 location.hostname
// ≠ archiveofourown.org 会禁用登录表单并跳转 /auth_error（日志实证：
// "[WV] nav: .../auth_error"）。服务端其实不拦（代理转发时 Host 已重写为
// 官方域，见 echproxy.go req.Host = target）——只要骗过前端检查即可。
// 效果等同"官方登录页"，验证/登录仍由官方处理，cookie 回写代理 jar。
function buildAntiPhishingBypass() {
  return `(function(){
    if (window.__echAntiPhishing) return;
    window.__echAntiPhishing = true;
    // 1) 拦截 location 赋值：AO3 authError 用 location.href='/auth_error'
    //    跳转，赋值是导航，必须在页面 JS 动手前拦住。
    try {
      var _loc = window.location;
      Object.defineProperty(window, 'location', {
        get: function() { return _loc; },
        set: function() { /* swallow navigation attempts (e.g. /auth_error) */ }
      });
    } catch(e) {}
    // 2) 解除登录表单禁用 + 移除反钓鱼警告条（AO3 检测非官方域名后
    //    会 disabled 提交按钮并插入警告）。
    function unblock() {
      var form = document.getElementById('new_user');
      if (form) {
        form.querySelectorAll('input, button, select, textarea').forEach(function(el) { el.disabled = false; });
      }
      document.querySelectorAll('.error, .warning, .caution, .notice, .flash').forEach(function(el) {
        if (/host|域名|官方|phish|钓鱼|non-?official/i.test(el.textContent || '')) el.remove();
      });
    }
    if (document.readyState !== 'loading') unblock();
    document.addEventListener('DOMContentLoaded', unblock);
    window.addEventListener('load', unblock);
    // 兜底轮询：AO3 的 JS 可能在事件里延迟插入警告/禁用
    var t = setInterval(function() { unblock(); }, 400);
    setTimeout(function() { clearInterval(t); }, 30000);
  })();
  true;`;
}

const CF_CHALLENGE_DETECTION = `
  (function() {
    const html = document.documentElement.outerHTML || '';
    const hasLoginForm = !!document.getElementById('new_user');
    const isChallenge =
      typeof window._cf_chl_opt !== 'undefined' ||
      !!document.querySelector('script[src*="cdn-cgi/challenge-platform"]') ||
      !!document.querySelector('script[src*="challenges.cloudflare.com"]') ||
      /_cf_chl_opt|challenge-platform|challenges\.cloudflare\.com|cf-chl-widget|turnstile/i.test(html) ||
      (location.hostname.indexOf('127.0.0.1') === 0 && /cdn-cgi\\/challenges/i.test(location.href));
    // 登录页只会是 CF 验证或登录表单。既无 challenge 特征也无 new_user
    // 表单(如 CF 新版验证页/错误页)→ 按 challenge 处理,保持窗口可见,
    // 让用户完成验证或人工判断。绝不能静默 settle 导致窗口一闪即关。
    // hasLoginForm 随消息带出,由 RN 侧按调用场景(preVerify/requireLoginForm)
    // 决定是否保持窗口。
    if (isChallenge || !hasLoginForm) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'challenge', hasLoginForm, isChallenge }));
      return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'success',
      body: html,
      acceptedTos: localStorage.getItem('accepted_tos'),
    }));
  })();
  true;
`;

const CF_INTERIM_STATUSES = new Set([403, 503]);

export const ACCEPTED_TOS_KEY = 'accepted_tos';

// 生成注入 JS：包装 fetch / XMLHttpRequest，把 AO3 的绝对 URL 改写为本地
// ECH 代理地址并自动带上 X-Ech-Target 头。CF challenge 的 orchestrate 验证
// 通过 XHR/fetch 提交到 https://archiveofourown.org/cdn-cgi/...（绝对 URL），
// 不经过 onShouldStartLoadWithRequest，若直连则被墙重置 → 验证永远通不过。
// 注意只改 fetch/XHR 的请求 URL 与头，不改页面自身的导航（导航走
// onShouldStartLoadWithRequest 处理）。base 形如 http://127.0.0.1:40301。
function buildFetchRewriter(base, targetHost) {
  const hostA = JSON.stringify('archiveofourown.org');
  const hostW = JSON.stringify('www.archiveofourown.org');
  const hostC = JSON.stringify('challenges.cloudflare.com');
  const baseJ = JSON.stringify(base);
  const targetJ = JSON.stringify(targetHost);
  return `(function(){
    if (window.__echRewriter) return;
    window.__echRewriter = true;
    function rewrite(url){
      try {
        var u = new URL(url);
        if (u.protocol === 'https:' && (u.hostname === ${hostA} || u.hostname === ${hostW} || u.hostname === ${hostC})) {
          return ${baseJ} + u.pathname + u.search;
        }
      } catch(e) {}
      return url;
    }
    // fetch
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function(input, init) {
        if (typeof input === 'string') {
          var rw = rewrite(input);
          if (rw !== input) {
            init = init || {};
            var h = new Headers(init.headers || {});
            h.set('X-Ech-Target', ${targetJ});
            init.headers = h;
            input = rw;
          }
        }
        return origFetch.call(this, input, init);
      };
    }
    // XMLHttpRequest
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      var rw = typeof url === 'string' ? rewrite(url) : url;
      if (rw !== url) {
        this.__echTarget = ${targetJ};
        arguments[1] = rw;
      }
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      if (this.__echTarget) {
        try { this.setRequestHeader('X-Ech-Target', this.__echTarget); } catch(e) {}
        this.__echTarget = null;
      }
      return origSend.apply(this, arguments);
    };
  })();
  true;`;
}

// --- Component ---

export default function WebviewFetcher() {
  const { t } = useTranslation();
  const [source, setSource] = useState(null);
  const [visible, setVisible] = useState(false);
  const [showCFWarning, setShowCFWarning] = useState(false);
  const webViewRef = useRef(null);
  const currentRef = useRef(null);
  const httpErrorRef = useRef(null);
  // 交互式登录：jar 轮询定时器 / 总超时定时器 / 最近一次 jar 快照。
  // jar 在 interactiveLogin 打开前已被 clearSessionCookies 清空，所以
  // 轮询到 _otwarchive_session 出现 = 登录成功（可靠，不依赖检测 JS）。
  const jarPollRef = useRef(null);
  const loginTimeoutRef = useRef(null);
  const lastJarInfoRef = useRef('');
  // 每次 fetchViaWebView 用新的 WebView 实例(key 递增强制重建)。
  // react-native-webview 的 incognito 在 Android 上只是创建时清一次全局
  // CookieManager,同一实例内的多次导航/复用会累积 cookie —— 日志实证
  // 登录时 WebView store 残留 session 导致 AO3 302 到 /users/xxx。
  // 重建实例 = 每次验证从零 cookie 开始,cf_clearance 由代理 jar 捕获
  // (请求走代理转发),不依赖 WebView store。
  const [webViewKey, setWebViewKey] = useState(0);

  const loadCurrent = () => {
    setVisible(false);
    setWebViewKey((k) => k + 1); // 强制重建 WebView 实例,清 cookie 残留
    const wvStart = Date.now();
    // 交互式登录：用户在 WebView 里填表提交完成登录（CF 验证也在窗口内）。
    // 打开前 jar 已被调用方清空，登录成功后 AO3 的 Set-Cookie 会经代理
    // 转发写回 jar → 轮询检测到 _otwarchive_session = 登录成功。
    if (currentRef.current?.interactiveLogin) {
      startLoginTimers();
    }
    // direct 模式（官方域名直连登录）：不走 ECH 代理——系统 WebView 自带
    // 真浏览器指纹 + ECH(用户网络实测 Chrome/Firefox+DoH 可直连官方登录,
    // CF 零验证)。域名官方 → 无反钓鱼检查；cookie 留在 WebView store,
    // 成功后由 CookieManager 读取。代理那套(127.0.0.1)对服务端域名检查
    // 无解,弃用。
    if (currentRef.current?.direct) {
      const uri = currentRef.current.url;
      console.log(`[WV] direct load ${uri} (${Date.now() - wvStart}ms)`);
      setSource({ uri });
      return;
    }
    // html 模式：渲染调用方提供的页面内容(CF challenge 页)。WebView 的
    // 唯一目的 = 完成 CF 人机验证交互：challenge 页是 CF 生成的(无 AO3
    // 域名检查),用户完成 Turnstile 后 CF 自动重放原始登录 POST(带
    // cf_clearance)→ 成功 → cookie 进 jar → jar 轮询判定完成。
    if (currentRef.current?.html) {
      const item = currentRef.current;
      console.log(`[WV] render challenge html (${item.html.length}b) base=${item.baseUrl} (${Date.now() - wvStart}ms)`);
      let injected = '';
      if (item.baseUrl) {
        const base = item.baseUrl.slice(0, item.baseUrl.indexOf('/', item.baseUrl.indexOf('://') + 3));
        const target = 'archiveofourown.org';
        injected = buildFetchRewriter(base, target);
      }
      if (item.interactiveLogin) {
        injected = (injected ? injected + '\n' : '') + buildAntiPhishingBypass();
        startLoginTimers();
      }
      setSource({
        html: item.html,
        baseUrl: item.baseUrl || 'about:blank',
        injectedJavaScriptBeforeContentLoaded: injected || undefined,
      });
      return;
    }
    // ECH 代理可用时，WebView 也走代理，避免直连被墙重置。
    // 2026-08-06：AO3 域名代理不可用时 rewriteForEch 会抛错（fail-closed），
    // 这里 settle 错误让调用方感知（不再静默直连）。
    rewriteForEch(currentRef.current.url)
      .then(({ uri, headers }) => {
        const proxied = uri !== currentRef.current.url;
        console.log(`[WV] loading ${currentRef.current.url} → ${proxied ? 'proxy' : 'direct'} (${Date.now() - wvStart}ms)`);
        // CF challenge 验证的核心链路是页面内 JS 的 XHR/fetch 子资源请求
        // （提交到 https://archiveofourown.org/cdn-cgi/challenge-platform/...），
        // 这些请求**不经过** onShouldStartLoadWithRequest（那只拦导航），
        // 若页面 URL 是代理地址 http://127.0.0.1:PORT/...，相对路径会走代理 ✓，
        // 但 CF 的 orchestrate JS 用**绝对 URL** 直连 archiveofourown.org → 被墙。
        // 所以在页面加载前注入包装，把 fetch/XHR 里的 AO3 绝对 URL 改写为
        // 代理地址并自动带 X-Ech-Target 头，让验证回调也走 ECH 代理。
        let injected = '';
        if (proxied && headers?.['X-Ech-Target']) {
          const base = uri.slice(0, uri.indexOf('/', uri.indexOf('://') + 3));
          injected = buildFetchRewriter(base, headers['X-Ech-Target']);
        }
        // 交互式登录：叠加反钓鱼绕过（AO3 前端检查 hostname → 禁用表单/跳
        // auth_error），让登录表单在代理域名下可用。
        if (currentRef.current?.interactiveLogin) {
          injected = (injected ? injected + '\n' : '') + buildAntiPhishingBypass();
        }
        setSource({ uri, headers, injectedJavaScriptBeforeContentLoaded: injected || undefined });
      })
      .catch((e) => {
        console.log(`[WV] refusing ${currentRef.current.url}: ${e?.message ?? e}`);
        settle(null, new WebViewFetchError(0, e?.message ?? 'ECH proxy unavailable', currentRef.current.url));
      });
  };

  const processNext = () => {
    if (currentRef.current || queue.length === 0) return;
    currentRef.current = queue.shift();
    httpErrorRef.current = null;
    loadCurrent();
  };

  useEffect(() => {
    triggerNext = processNext;
    return () => { triggerNext = null; };
  }, []);

  const onWarningDismiss = () => {
    setShowCFWarning(false);
    // 保持 WebView 可见：用户需要在这个窗口里完成 Cloudflare 验证，
    // 验证通过后页面会自动重定向到目标页并触发 success。
    // 不能重新 loadCurrent() —— 那会重新进入 challenge 循环。
  };

  // 从 jarInfo 文本里提取 AO3 会话 cookie 值。
  // jar 已清空时，非空出现即登录成功。形如：
  //   _otwarchive_session=abc123 domain="" path="" secure=false maxAge=0
  const parseSessionFromJar = (jarText) => {
    if (!jarText) return null;
    const m = String(jarText).match(/_otwarchive_session=([^\s]+)/);
    return m?.[1] || null;
  };

  // 已登录判定：jar 里必须出现 user_credentials（AO3 登录成功才设置的
  // 标记）。⚠️ 不能只看 _otwarchive_session —— WebView 加载登录表单页时
  // AO3 对匿名访问也会 Set-Cookie 一个 session（日志实证），见 session 就
  // 判定成功会让窗口 1.5 秒误关、用户根本没机会填表、存的是匿名 session。
  const isLoggedInJar = (jarText) => {
    if (!jarText) return false;
    return /user_credentials=[^\s]+/.test(String(jarText));
  };

  const cleanupLoginTimers = () => {
    if (jarPollRef.current) {
      clearInterval(jarPollRef.current);
      jarPollRef.current = null;
    }
    if (loginTimeoutRef.current) {
      clearTimeout(loginTimeoutRef.current);
      loginTimeoutRef.current = null;
    }
  };

  // 交互式登录成功：用户已在 WebView 里完成登录（导航离开 /users/login
  // 或 jar 轮询到 session）。读 jar 里的 session 并结束。
  const finishInteractiveLogin = (reason) => {
    const session = parseSessionFromJar(lastJarInfoRef.current);
    console.log(`[WV] interactive login done (${reason}), session=${session ? 'found' : 'MISSING'}`);
    settle({ session }, null);
  };

  // 官方域名直连登录成功：cookie 在 WebView store（不走代理 jar），
  // 从 CookieManager 读 _otwarchive_session 返回给调用方。
  const finishDirectLogin = async () => {
    try {
      const cookies = await CookieManager.get('https://archiveofourown.org');
      const session = cookies?._otwarchive_session?.value || null;
      console.log(`[WV] direct login done, session=${session ? 'found' : 'MISSING'}`);
      settle({ session }, null);
    } catch (e) {
      console.log('[WV] direct login cookie read failed:', e?.message ?? e);
      settle({ session: null }, null);
    }
  };

  const startLoginTimers = () => {
    cleanupLoginTimers();
    // direct 模式(官方域名直连)不轮询 jar——cookie 在 WebView store 不在
    // 代理 jar，成功由导航检测 + CookieManager 读取。仅代理模式轮询。
    if (!currentRef.current?.direct) {
      // jar 轮询兜底：导航检测漏了也能靠 cookie 判定登录成功。
      // 判定条件 = user_credentials 出现（真正登录成功）；匿名 session
      // 不算（见 isLoggedInJar 注释）。
      jarPollRef.current = setInterval(async () => {
        try {
          const jarText = await getJarInfo();
          lastJarInfoRef.current = jarText ?? '';
          if (currentRef.current?.interactiveLogin && isLoggedInJar(jarText)) {
            console.log('[WV] interactive login detected via jar user_credentials');
            finishInteractiveLogin('jar');
          }
        } catch (e) {
          // 轮询失败忽略，下个周期再试
        }
      }, 1500);
    }
    // 总超时：5 分钟后窗口还开着就失败（用户可能已放弃/网络卡死）。
    loginTimeoutRef.current = setTimeout(() => {
      console.log('[WV] interactive login timed out after 5min');
      settle(null, new WebViewFetchError(0, 'Interactive login timed out', currentRef.current?.url));
    }, 5 * 60 * 1000);
  };

  const settle = (value, error) => {
    const item = currentRef.current;
    currentRef.current = null;
    cleanupLoginTimers();
    setSource(null);
    setVisible(false);
    error ? item?.reject(error) : item?.resolve(value);
    setTimeout(processNext, 150);
  };

  const onLoadEnd = () => {
    const err = httpErrorRef.current;
    httpErrorRef.current = null;

    if (err && !CF_INTERIM_STATUSES.has(err.status)) {
      settle(null, new WebViewFetchError(err.status, err.statusText, err.url));
      return;
    }

    // 登录流程(requireLoginForm)先让窗口可见——用户必须能看到页面
    // (CF 验证界面/登录表单),即使检测 JS 漏判也能人工完成验证;
    // 检测到纯表单会立即 settle 关闭。preVerify 预热模式不抢先显示
    // (无验证时秒过不打扰),检测到 challenge 再由 onMessage 显示。
    // 交互式登录(interactiveLogin)始终显示——用户要在窗口里完成
    // 整个登录,不能依赖任何检测 JS,也绝不自动 settle。
    if (currentRef.current?.requireLoginForm || currentRef.current?.interactiveLogin) {
      setVisible(true);
    }
    // 交互式登录不注入 CF_CHALLENGE_DETECTION：窗口由用户操作驱动
    // (填表/完成验证),检测 JS 只会造成误判提前 settle(历史 10 次
    // 失败的根因之一)。成功判定靠导航 + jar 轮询,与页面内容无关。
    if (!currentRef.current?.interactiveLogin) {
      webViewRef.current?.injectJavaScript(CF_CHALLENGE_DETECTION);
    }
  };

  const onHttpError = ({ nativeEvent }) => {
    httpErrorRef.current = {
      status: nativeEvent.statusCode,
      statusText: nativeEvent.description || String(nativeEvent.statusCode),
      url: nativeEvent.url,
    };
  };

  const onError = ({ nativeEvent }) => {
    settle(null, new WebViewFetchError(
      nativeEvent.code ?? 0,
      nativeEvent.description ?? 'Network error',
      nativeEvent.url,
    ));
  };

  const onMessage = ({ nativeEvent }) => {
    try {
      const data = JSON.parse(nativeEvent.data);
      // 交互式登录：页面内 JS 的 postMessage 一律忽略——窗口由用户
      // 操作驱动，成功判定靠导航 + jar 轮询（见 onShouldStartLoadWithRequest
      // 与 startLoginTimers），不能让任何页面消息提前 settle。
      if (currentRef.current?.interactiveLogin) {
        return;
      }
      if (data.type === 'challenge') {
        // 真 challenge(带 CF 特征)→ 显示窗口让用户完成验证,所有场景
        // (preVerify 预热也要完成,cf_clearance 才能进 jar)。
        if (data.isChallenge) {
          if (currentRef.current?.cfWarning) {
            setShowCFWarning(true);
          }
          setVisible(true);
          return;
        }
        // 仅"无登录表单"的普通页面(如 preVerify 加载的主页)→ 非登录
        // 流程正常结束;登录流程(requireLoginForm)保持窗口(可能是
        // CF 新版验证页/错误页,等 CF 重定向到表单)。
        if (!currentRef.current?.requireLoginForm) {
          settle(data.body ?? '', null);
          return;
        }
        setVisible(true);
        return;
      }
      if (data.type === 'success') {
        // 兜底：即使注入的检测 JS 漏判，body 里只要还残留 challenge
        // 特征（_cf_chl_opt / challenge-platform / turnstile 等），
        // 就绝不能 settle —— 否则调用方拿到 challenge 页去解析表单，
        // 提取不到 token，登录无限重试。保持窗口可见等用户完成验证。
        const body = String(data.body ?? '');
        console.log(`[WV] success body head: ${body.slice(0, 260).replace(/\s+/g, ' ')}`);
        if (/_cf_chl_opt|challenge-platform|challenges\.cloudflare\.com|cf-chl-widget|turnstile/i.test(body)) {
          console.log('[WV] success body still looks like a CF challenge, keeping window open');
          setVisible(true);
          return;
        }
        // 预热验证模式(preVerify)：页面已正常加载且非 challenge →
        // cf_clearance 已进 jar，直接结束，不需要是登录表单。
        if (currentRef.current?.preVerify) {
          settle(data.body, null);
          return;
        }
        // 登录流程要求页面是登录表单(new_user)。无表单(CF 新版验证页/
        // 错误页)→ 保持窗口可见,等用户完成验证后 CF 重定向到表单。
        if (currentRef.current?.requireLoginForm && !body.includes('new_user')) {
          console.log('[WV] requireLoginForm but no new_user form, keeping window open');
          setVisible(true);
          return;
        }
        if (data.acceptedTos) {
          AsyncStorage.setItem(ACCEPTED_TOS_KEY, data.acceptedTos).catch(() => {});
        }
        settle(data.body, null);
        return;
      }
      settle(null, new WebViewFetchError(0, data.error ?? 'WebView extraction failed', source?.uri));
    } catch (e) {
      settle(null, e);
    }
  };

  // 用户手动关闭验证窗口(卡住/不想验证时兜底)。
  const onCloseWindow = () => {
    console.log('[WV] user closed verification window');
    settle(
      null,
      new WebViewFetchError(0, 'Verification window closed by user', currentRef.current?.url),
    );
  };

  // 禁止系统浏览器弹出：CF 验证窗口内所有导航都留在 WebView 里。
  const onOpenWindow = () => {
    // 吞掉 window.open —— 绝不跳到系统浏览器。
    console.log('[WV] blocked window.open (system browser)');
  };

  const onShouldStartLoadWithRequest = (request) => {
    const url = request?.url ?? '';
    if (!url) return true;
    try {
      const u = new URL(url);

      // 交互式登录：AO3 前端反钓鱼把表单页跳去 /auth_error——绝不是登录
      // 成功路径，拦住留在登录页（注入 JS 也会拦 location 赋值，双保险）。
      // direct 模式(官方域名)不会有 auth_error 检查,此拦截仅代理模式需要。
      if (!currentRef.current?.direct && currentRef.current?.interactiveLogin && u.pathname === '/auth_error') {
        console.log('[WV] blocked anti-phishing redirect to /auth_error');
        return false;
      }

      // 交互式登录：AO3 域导航离开 /users/login（且非 CF 验证路径）→
      // 登录成功。AO3 登录成功必然 302 到 /users/{username} 或首页；
      // 密码错误则 302 回 /users/login（继续等待用户重试）。此刻
      // Set-Cookie 已随代理转发写入 jar，读 jar 拿 session 结束窗口。
      // direct 模式下 cookie 在 WebView store，成功由 CookieManager 读取。
      if (
        currentRef.current?.interactiveLogin &&
        (u.hostname === 'archiveofourown.org' || u.hostname === 'www.archiveofourown.org') &&
        u.protocol === 'https:'
      ) {
        const p = u.pathname;
        if (!p.startsWith('/users/login') && !p.startsWith('/users/session') && !p.startsWith('/cdn-cgi/')) {
          console.log(`[WV] interactive login: navigated to ${p} — success`);
          if (currentRef.current?.direct) {
            // 官方域名直连：登录 cookie 在 WebView store，读出来返回。
            finishDirectLogin();
          } else {
            getJarInfo()
              .then((txt) => { lastJarInfoRef.current = txt ?? ''; })
              .catch(() => {})
              .finally(() => finishInteractiveLogin('nav'));
          }
          return false; // 阻止导航：已登录，无需再加载页面
        }
      }

      // direct 模式：官方域名直连，所有导航原样放行（不再改写代理）。
      if (currentRef.current?.direct) {
        return true;
      }

      // Cloudflare 验证回调。全部走本地 ECH 代理改写：
      // - archiveofourown.org/cdn-cgi/...：AO3 域下路径，直连被墙。
      // - challenges.cloudflare.com：未被墙但直连极慢（国际线路绕路），
      //   走代理 + DoH 优选 IP 更快更稳；代理不可用时 rewriteForEch
      //   会降级直连（CF 域能通，只是慢）。
      if (PROXIED_HOSTS.has(u.hostname) && (u.hostname === 'challenges.cloudflare.com' || u.pathname.startsWith('/cdn-cgi/'))) {
        console.log(`[WV] CF callback via proxy: ${url}`);
        rewriteForEch(url)
          .then(({ uri, headers }) => {
            if (headers) {
              console.log(`[WV] reload CF callback via proxy: ${uri}`);
              const base = uri.slice(0, uri.indexOf('/', uri.indexOf('://') + 3));
              setSource({
                uri,
                headers,
                injectedJavaScriptBeforeContentLoaded: buildFetchRewriter(base, headers['X-Ech-Target']) || undefined,
              });
            } else {
              console.log(`[WV] CF callback not proxiable, staying: ${url}`);
            }
          })
          .catch((e) => console.log(`[WV] CF callback rewrite failed: ${e?.message ?? e}`));
        return false; // 阻止当前导航，改写后重新加载
      }

      // Cloudflare 验证通过后常以绝对地址重定向回 https://archiveofourown.org。
      // 这种导航必须改写为本地 ECH 代理地址，否则直连暴露 SNI 会被墙重置。
      // 代理地址本身（http://127.0.0.1:<port>/...）不在此列，正常放行。
      if (u.hostname === 'archiveofourown.org' || u.hostname === 'www.archiveofourown.org') {
        if (u.protocol === 'https:') {
          console.log(`[WV] intercept AO3 nav → rewrite ${url}`);
          rewriteForEch(url)
            .then(({ uri, headers }) => {
              if (headers) {
                console.log(`[WV] reload via proxy: ${uri}`);
                // 同样注入 fetch/XHR 改写（CF 验证通过后重定向回 AO3 页面时，
                // 页面里后续的子资源/回调仍需要走代理）。
                const base = uri.slice(0, uri.indexOf('/', uri.indexOf('://') + 3));
                setSource({
                  uri,
                  headers,
                  injectedJavaScriptBeforeContentLoaded: buildFetchRewriter(base, headers['X-Ech-Target']) || undefined,
                });
              } else {
                console.log(`[WV] target not proxiable, staying: ${url}`);
              }
            })
            .catch((e) => console.log(`[WV] rewrite failed: ${e?.message ?? e}`));
          return false; // 阻止当前导航，改写后重新加载
        }
      }
    } catch {}
    console.log(`[WV] nav: ${url}`);
    return true;
  };

  return (
    <>
      <Modal
        visible={showCFWarning}
        transparent
        animationType="fade"
        onRequestClose={onWarningDismiss}
      >
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <Text style={styles.title}>{t('webview_antibot_title')}</Text>
            <Text style={styles.body}>{t('webview_antibot_body')}</Text>
            <Pressable style={styles.button} onPress={onWarningDismiss}>
              <Text style={styles.buttonText}>
                {t('webview_antibot_confirm')}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {source && (
        <View style={[styles.webviewBase, visible ? styles.visible : styles.hidden]}>
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={source}
            onLoadEnd={onLoadEnd}
            onHttpError={onHttpError}
            onError={onError}
            onMessage={onMessage}
            onOpenWindow={onOpenWindow}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            javaScriptEnabled
            domStorageEnabled
            // 无痕模式：验证窗口必须从零 cookie 开始，否则 WebView 自带的
            // 残留会话 cookie(按 127.0.0.1 域存储)会让 AO3 判定已登录并
            // 302 到 /users/xxx，CF 验证窗口永不弹出（日志实证：
            // "[WV] nav: .../users/anglesya" + "/lost_cookie"）。
            // 注意：不能开 sharedCookiesEnabled —— 那会把 RN 层 cookie
            // 带进验证窗口，重新引入同样的问题。cf_clearance 由代理侧
            // cookiejar 捕获（请求走代理转发），不依赖 WebView cookie。
            // ⚠️ direct 模式(官方域名直连)不能用 incognito：登录 cookie
            // 必须写进全局 CookieManager，成功后 finishDirectLogin 才能
            // 用 CookieManager.get 读回 _otwarchive_session。
            incognito={!currentRef.current?.direct}
            cacheEnabled={false}
            startInLoadingState={visible}
          />
          {visible && (
            <Pressable style={styles.closeBtn} onPress={onCloseWindow} hitSlop={10}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          )}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // WebView
  webviewBase: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 9999,
  },
  visible: {
    backgroundColor: 'white',
    opacity: 1,
    pointerEvents: 'auto',
  },
  hidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
  closeBtn: {
    position: 'absolute',
    top: 36,
    right: 12,
    zIndex: 10001,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 18,
  },

  // Modal
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modal: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 24,
    gap: 12,
    maxWidth: 360,
    width: '100%',
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    color: '#555',
  },
  button: {
    marginTop: 4,
    backgroundColor: '#111',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 15,
  },
});
