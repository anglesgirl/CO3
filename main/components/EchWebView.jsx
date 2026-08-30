import React from 'react';
import { requireNativeComponent, StyleSheet } from 'react-native';

const NativeEchWebView = requireNativeComponent('EchWebView');

export default function EchWebView({ sourceUrl, style, ...props }) {
  return <NativeEchWebView sourceUrl={sourceUrl} style={[styles.webview, style]} {...props} />;
}

const styles = StyleSheet.create({
  webview: { flex: 1 },
});
