import React, { useEffect } from 'react';
import { View, ActivityIndicator, TouchableOpacity, Text, StyleSheet, DeviceEventEmitter } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import EchWebView from './EchWebView';
import { WebView } from 'react-native-webview';

export default function InternalBrowser() {
  const navigation = useNavigation();
  const route = useRoute();
  const { url, title } = route.params || {};

  // 登录成功事件：同步 Keychain，返回时账号中心自动刷新
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('LoginSuccess', () => {
      try { require('../web/syncSession').syncSessionFromNative(); } catch {}
    });
    return () => sub.remove();
  }, []);

  if (!url) {
    return <View style={styles.center}><Text>无链接</Text></View>;
  }

  const isAO3 = url.includes('archiveofourown.org');

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Icon name="arrow-back" size={24} color="#333" />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{title || url}</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.closeBtn}>
          <Icon name="close" size={24} color="#333" />
        </TouchableOpacity>
      </View>
      {isAO3 ? (
        <EchWebView sourceUrl={url} style={styles.webview} />
      ) : (
        <WebView
          source={{ uri: url }}
          startInLoadingState
          renderLoading={() => <View style={styles.center}><ActivityIndicator size="large" /></View>}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, borderBottomWidth: 1, borderColor: '#eee', paddingHorizontal: 8 },
  backBtn: { padding: 8 },
  closeBtn: { padding: 8 },
  title: { flex: 1, textAlign: 'center', fontWeight: '600' },
  webview: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
