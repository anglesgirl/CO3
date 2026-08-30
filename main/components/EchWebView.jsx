import React from 'react';
import { requireNativeComponent, StyleSheet } from 'react-native';

const NativeEchWebView = requireNativeComponent('EchWebView');

export default function EchWebView({ sourceUrl, style, onLoginSuccess, ...props }) {
  return <NativeEchWebView sourceUrl={sourceUrl} style={[styles.webview, style]} onLoginSuccess={onLoginSuccess} {...props} />;
}

const styles = StyleSheet.create({
  webview: { flex: 1 },
});
