/**
 * 应用内 ECH 浏览器 —— AO3 等 **ECH 保护域名**唯一允许的打开方式。
 *
 * 【为什么必须存在这个组件】
 * AO3 是 ECH 保护域名。一旦把它的链接交给系统浏览器
 * （InAppBrowser.open / Linking.openURL），TLS 握手就**绕开了 App 的
 * Conscrypt + ECH 通道**，ClientHello 里的 SNI 是明文 archiveofourown.org
 * —— 真机上已经因为这个入口泄露过一次。
 *
 * 本组件复用原生 EchWebView（它的 shouldInterceptRequest 走 CoWebViewHelper
 * = ECH 通道），因此在内置浏览器里浏览 AO3 同样不暴露 SNI。
 *
 * 【fail-closed】
 * ECH 域名**绝不回落**到系统浏览器：
 *   - 宿主未挂载 / 平台无原生组件 → 直接拒绝并提示，而不是"顺手用系统浏览器打开"。
 *   - 只有**非** ECH 域名（ko-fi、帮助文档之类）才按原方式交给外部打开。
 *
 * 【用法】
 *   1) 根组件挂一次：<EchBrowserHost />（已在 main/app.jsx 挂好）
 *   2) 任何地方：import { openEchBrowser } from '.../components/EchBrowser';
 *      openEchBrowser('https://archiveofourown.org/works/123');
 */
import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  requireNativeComponent,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { AppContext } from '../../app';
import { isEchProtectedUrl } from '../../web/WebviewFetcher';

/**
 * 原生 EchWebView 只在 Android 上注册（iOS 侧没有 ECH 原生实现）。
 * requireNativeComponent 在组件不存在时会抛错，所以必须包起来 ——
 * 抛出去会让整个 bundle 启动失败（这类"启动即崩"的坑已经踩过一次）。
 */
let NativeEchWebView = null;
try {
  if (Platform.OS === 'android') {
    NativeEchWebView = requireNativeComponent('EchWebView');
  }
} catch (e) {
  NativeEchWebView = null;
}

/** 由 <EchBrowserHost /> 注册进来的打开函数（宿主未挂载时为 null）。 */
let openHostFn = null;

/**
 * 打开链接。
 *   ECH 保护域名 → 应用内 ECH 浏览器（唯一的正确路径）
 *   其它域名     → 交给外部打开（传 fallbackOpen 则用它，否则 Linking）
 *
 * 注意：ECH 域名**没有** fallback 分支，拿不到宿主就拒绝。
 */
export function openEchBrowser(url, fallbackOpen) {
  // 统一返回 Promise：调用方有的 `await`、有的 `.catch()`，
  // 返回值不是 Promise 的话后者会直接抛 TypeError（真机上就是这么炸的）。
  if (!url) return Promise.resolve();
  if (isEchProtectedUrl(url)) {
    if (openHostFn) {
      openHostFn(url);
      return Promise.resolve();
    }
    // fail-closed：宁可不打开，也不把这个域名的请求交给系统浏览器
    Alert.alert('无法打开', '应用内加密浏览器尚未就绪，已阻止打开（避免明文暴露域名）。');
    return Promise.resolve();
  }
  if (typeof fallbackOpen === 'function') {
    try {
      fallbackOpen(url);
    } catch (_) {}
    return Promise.resolve();
  }
  return Linking.openURL(url).catch(() => {});
}

/** 单例宿主：挂在根组件里一次即可。 */
export function EchBrowserHost() {
  const appCtx = useContext(AppContext);
  const currentTheme = (appCtx && appCtx.currentTheme) || {};
  const { t } = useTranslation();
  const [url, setUrl] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    openHostFn = setUrl;
    return () => {
      if (openHostFn === setUrl) openHostFn = null;
    };
  }, []);

  const close = useCallback(() => {
    setUrl(null);
    setReloadKey(0);
  }, []);

  if (!url) return null;

  const bg = currentTheme.backgroundColor || '#ffffff';
  const bar = currentTheme.headerBackground || bg;
  const border = currentTheme.borderColor || '#e5e5e5';
  const textColor = currentTheme.textColor || '#111111';
  const iconColor = currentTheme.iconColor || textColor;
  const subColor = currentTheme.placeholderColor || '#888888';

  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={close}
      presentationStyle="fullScreen"
    >
      <View style={[styles.root, { backgroundColor: bg }]}>
        <StatusBar
          barStyle={currentTheme.isDark ? 'light-content' : 'dark-content'}
          backgroundColor={bar}
        />
        <View style={[styles.bar, { backgroundColor: bar, borderBottomColor: border }]}>
          <TouchableOpacity onPress={close} style={styles.btn} accessibilityLabel="close">
            <Icon name="close" size={24} color={iconColor} />
          </TouchableOpacity>
          <Text numberOfLines={1} style={[styles.url, { color: textColor }]}>
            {String(url).replace(/^https?:\/\//, '')}
          </Text>
          <TouchableOpacity
            onPress={() => setReloadKey(k => k + 1)}
            style={styles.btn}
            accessibilityLabel="reload"
          >
            <Icon name="refresh" size={24} color={iconColor} />
          </TouchableOpacity>
        </View>

        {NativeEchWebView ? (
          // key 变化即重建，用于"刷新"
          <NativeEchWebView key={reloadKey} sourceUrl={url} style={styles.web} />
        ) : (
          // fail-closed：平台/组件不可用时明确拒绝，不偷偷改用系统浏览器
          <View style={styles.center}>
            <Icon name="lock-outline" size={48} color={iconColor} />
            <Text style={[styles.tip, { color: textColor }]}>
              {t('ech_browser_unsupported')}
            </Text>
            <Text style={[styles.tipSub, { color: subColor }]}>{t('ech_browser_fail_closed')}</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    height: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  btn: { padding: 8 },
  url: { flex: 1, fontSize: 14, marginHorizontal: 6 },
  web: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  tip: { fontSize: 16, fontWeight: '600', marginTop: 16, textAlign: 'center' },
  tipSub: { fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 19 },
});

export default EchBrowserHost;
