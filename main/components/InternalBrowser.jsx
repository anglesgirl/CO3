import React, { useState, useEffect, useRef } from 'react';
import { View, ActivityIndicator, TouchableOpacity, Text, StyleSheet, Alert } from 'react-native';
import { WebView } from 'react-native-webview';
import { useNavigation, useRoute } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';

export default function InternalBrowser() {
  const navigation = useNavigation();
  const route = useRoute();
  const { url: initialUrl, title } = route.params || {};
  const [url, setUrl] = useState(initialUrl);
  const [html, setHtml] = useState(null);
  const [loading, setLoading] = useState(true);
  const webRef = useRef(null);

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    // 通过 JS fetch 走 CoEchInterceptor (ECH)，再注入 WebView
    fetch(url, { headers: { 'User-Agent': 'CO3-ECH' } })
      .then(r => {
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        return r.text();
      })
      .then(text => {
        setHtml(text);
        setLoading(false);
      })
      .catch(e => {
        setLoading(false);
        Alert.alert('加载失败', String(e.message || e));
      });
  }, [url]);

  const handleShouldStartLoad = (req) => {
    const newUrl = req.url;
    // AO3 内部链接继续用 ECH 内部加载，外部链接才提示
    if (newUrl.includes('archiveofourown.org')) {
      if (newUrl !== url) {
        setUrl(newUrl);
        return false;
      }
      return true;
    }
    return true;
  };

  if (!initialUrl) {
    return <View style={styles.center}><Text>无链接</Text></View>;
  }

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
      {loading && !html ? (
        <View style={styles.center}><ActivityIndicator size="large" /></View>
      ) : (
        <WebView
          ref={webRef}
          source={html ? { html, baseUrl: url } : { uri: url }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          startInLoadingState
          renderLoading={() => <View style={styles.center}><ActivityIndicator size="large" /></View>}
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
