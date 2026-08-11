import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import WebView from 'react-native-webview';
import { getEchBase } from '../../web/echKy';
import { AO3_HOSTS } from '../../utils/openExternalLink';

/**
 * 应用内浏览器（走 ECH 代理）。
 *
 * 用途：AO3 链接 / Cloudflare 人机验证页面必须在 App 内打开——外部系统
 * 浏览器是独立进程，拿不到 App 的本地 ECH 代理端口，在 DNS 被污染的网络
 * 里直连 archiveofourown.org 会连接重置。这里复用 WebviewFetcher 的做法：
 * 把 https://archiveofourown.org/<path> 改写成
 * http://127.0.0.1:<port>/<path> + X-Ech-Target 头，由本地 Go 代理完成
 * 带 ECH 的上游 TLS。
 *
 * 注意：改写只对首个导航生效（WebView 内部再点链接由 onShouldStartLoad
 * 拦下来重新改写）。
 */
export default function InAppBrowser({ url, visible, onClose, title }) {
  const [source, setSource] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!visible || !url) {
      setSource(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const next = await buildSource(url);
        if (!cancelled) setSource(next);
      } catch (e) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, visible]);

  const onNavigationRequest = (req) => {
    const target = req?.url ?? '';
    // 本地代理 URL 直接放行；外部 https 链接重新改写后加载。
    if (target.startsWith('http://127.0.0.1') || target.startsWith('about:')) {
      return true;
    }
    if (!/^https?:\/\//i.test(target)) return false;
    buildSource(target)
      .then(next => setSource(next))
      .catch(e => setError(e?.message ?? String(e)));
    return false;
  };

  return (
    <Modal visible={!!visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.bar}>
          <Text numberOfLines={1} style={styles.title}>
            {title || url || ''}
          </Text>
          <Pressable onPress={onClose} hitSlop={12} style={styles.close}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        {error ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : source ? (
          <>
            <WebView
              source={source}
              onShouldStartLoadWithRequest={onNavigationRequest}
              onLoadEnd={() => setLoading(false)}
              onError={({ nativeEvent }) =>
                setError(nativeEvent?.description ?? 'Network error')
              }
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              style={styles.webview}
            />
            {loading && (
              <View style={styles.loading} pointerEvents="none">
                <ActivityIndicator size="large" />
              </View>
            )}
          </>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator size="large" />
          </View>
        )}
      </View>
    </Modal>
  );
}

async function buildSource(url) {
  const u = new URL(url);
  if (!AO3_HOSTS.has(u.hostname.toLowerCase())) {
    // 非 AO3：不强制走代理（这些站点没被墙），但 https 也允许直连。
    return { uri: url };
  }
  const base = await getEchBase();
  if (!base) {
    // fail-closed：与 WebviewFetcher 一致，不静默直连（污染网络下必失败，
    // 会让用户看到"半残页面"而不是明确的错误）。
    throw new Error('ECH proxy unavailable; cannot open AO3 link safely.');
  }
  return {
    uri: base + u.pathname + u.search,
    headers: { 'X-Ech-Target': u.hostname },
  };
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
    gap: 12,
  },
  title: { flex: 1, fontSize: 13, color: '#333' },
  close: { paddingHorizontal: 6 },
  closeText: { fontSize: 18, color: '#333' },
  webview: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: '#c62828', fontSize: 14, textAlign: 'center' },
  loading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
