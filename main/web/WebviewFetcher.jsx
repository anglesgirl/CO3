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
 * 非 AO3 的 URL 或代理不可用时原样返回（不 throw）。
 */
async function rewriteForEch(url) {
  try {
    const base = await getEchBase();
    if (!base) return { uri: url, headers: undefined };
    const u = new URL(url);
    if (!AO3_HOSTS.has(u.hostname)) return { uri: url, headers: undefined };
    return {
      uri: base + u.pathname + u.search,
      headers: { 'X-Ech-Target': u.hostname },
    };
  } catch {
    return { uri: url, headers: undefined };
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
    // ECH 代理可用时，WebView 也走代理，避免直连被墙重置。
    rewriteForEch(currentRef.current.url).then(({ uri, headers }) => {
      setSource(headers ? { uri, headers } : { uri });
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
    loadCurrent();
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
        if (currentRef.current?.cfWarning) {
          setShowCFWarning(true);
        } else {
          setVisible(true);
        }
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
