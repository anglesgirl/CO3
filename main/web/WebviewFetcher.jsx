import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import WebView from 'react-native-webview';
import { useTranslation } from 'react-i18next';
import { getEchBase } from './echKy';

const AO3_HOSTS = new Set(['archiveofourown.org', 'www.archiveofourown.org']);

/**
 * 如果 ECH 代理可用，把 AO3 直链改写为本地代理 URL，
 * 这样 WebView 也不裸连 archiveofourown.org（否则被墙重置 -6）。
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
    if (AO3_HOSTS.has(u.hostname)) {
      if (!base) {
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

export function fetchViaWebView(url, { cfWarning = false } = {}) {
  return new Promise((resolve, reject) => enqueue({ url, resolve, reject, cfWarning }));
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

const CF_CHALLENGE_DETECTION = `
  (function() {
    const isChallenge =
      typeof window._cf_chl_opt !== 'undefined' ||
      !!document.querySelector('script[src*="cdn-cgi/challenge-platform"]') ||
      !!document.querySelector('script[src*="challenges.cloudflare.com"]');

    if (isChallenge) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'challenge' }));
      return;
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'success',
      body: document.documentElement.outerHTML,
      acceptedTos: localStorage.getItem('accepted_tos'),
    }));
  })();
  true;
`;

const CF_INTERIM_STATUSES = new Set([403, 503]);

export const ACCEPTED_TOS_KEY = 'accepted_tos';

// --- Component ---

export default function WebviewFetcher() {
  const { t } = useTranslation();
  const [source, setSource] = useState(null);
  const [visible, setVisible] = useState(false);
  const [showCFWarning, setShowCFWarning] = useState(false);
  const webViewRef = useRef(null);
  const currentRef = useRef(null);
  const httpErrorRef = useRef(null);

  const loadCurrent = () => {
    setVisible(false);
    const wvStart = Date.now();
    // ECH 代理可用时，WebView 也走代理，避免直连被墙重置。
    // 2026-08-06：AO3 域名代理不可用时 rewriteForEch 会抛错（fail-closed），
    // 这里 settle 错误让调用方感知（不再静默直连）。
    rewriteForEch(currentRef.current.url)
      .then(({ uri, headers }) => {
        const proxied = uri !== currentRef.current.url;
        console.log(`[WV] loading ${currentRef.current.url} → ${proxied ? 'proxy' : 'direct'} (${Date.now() - wvStart}ms)`);
        setSource(headers ? { uri, headers } : { uri });
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

  const settle = (value, error) => {
    const item = currentRef.current;
    currentRef.current = null;
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

    webViewRef.current?.injectJavaScript(CF_CHALLENGE_DETECTION);
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
      if (data.type === 'challenge') {
        // 核心修复：无论 cfWarning 与否，都必须让 WebView 可见，
        // 用户需要在这个窗口里完成 Cloudflare 验证（点选/自动通过）。
        // 之前 cfWarning=true 时只弹警告、WebView 保持隐藏，
        // 导致用户永远无法完成验证 → 登录无限失败。
        if (currentRef.current?.cfWarning) {
          setShowCFWarning(true);
        }
        setVisible(true);
        return;
      }
      if (data.type === 'success') {
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

      // Cloudflare 验证回调：cdn-cgi/challenge-platform 和 challenges.cloudflare.com
      // 必须直接放行，不能改写为代理——CF 验证的 JS 通过 XHR/fetch/form-POST 提交
      // 到这些端点来证明浏览器合法性，走代理会破坏验证签名导致永远通不过。
      if (
        (AO3_HOSTS.has(u.hostname) && u.pathname.startsWith('/cdn-cgi/')) ||
        u.hostname === 'challenges.cloudflare.com'
      ) {
        console.log(`[WV] allow CF challenge nav: ${url}`);
        return true;
      }

      // Cloudflare 验证通过后常以绝对地址重定向回 https://archiveofourown.org。
      // 这种导航必须改写为本地 ECH 代理地址，否则直连暴露 SNI 会被墙重置。
      // 代理地址本身（http://127.0.0.1:<port>/...）不在此列，正常放行。
      if (AO3_HOSTS.has(u.hostname) && u.protocol === 'https:') {
        console.log(`[WV] intercept AO3 nav → rewrite ${url}`);
        rewriteForEch(url)
          .then(({ uri, headers }) => {
            if (headers) {
              console.log(`[WV] reload via proxy: ${uri}`);
              setSource({ uri, headers });
            } else {
              console.log(`[WV] target not proxiable, staying: ${url}`);
            }
          })
          .catch((e) => console.log(`[WV] rewrite failed: ${e?.message ?? e}`));
        return false; // 阻止当前导航，改写后重新加载
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
            sharedCookiesEnabled
            cacheEnabled
            startInLoadingState={visible}
          />
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
