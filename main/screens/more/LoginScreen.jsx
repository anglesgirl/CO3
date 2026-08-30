import React, { useContext, useEffect, useState, useCallback } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppContext } from '../../app';
import { getUsername, getCredsToken } from '../../storage/Credentials';
import { validateCookie } from '../../web/account/login';
import CookieManager from '@react-native-cookies/cookies';

const LoginScreen = () => {
  const { currentTheme } = useContext(AppContext);
  const navigation = useNavigation();
  const [user, setUser] = useState('');
  const [logged, setLogged] = useState(false);
  const [validating, setValidating] = useState(true);

  const check = useCallback(async () => {
    setValidating(true);
    try {
      const u = await getUsername();
      setUser(u || '');
      // 优先检查 WebView Cookie（官方登录后的真实状态）
      const cookies = await CookieManager.get('https://archiveofourown.org').catch(() => ({}));
      const hasSession = !!(cookies && cookies['_otwarchive_session']);
      if (hasSession) {
        setLogged(true);
        setValidating(false);
        return;
      }
      const token = await getCredsToken();
      if (token) {
        const ok = await validateCookie(token).catch(() => false);
        setLogged(ok);
      } else setLogged(false);
    } catch { setLogged(false); } finally { setValidating(false); }
  }, []);

  useEffect(() => { check(); }, [check]);
  useFocusEffect(useCallback(() => { check(); }, [check]));

  const open = (url, title) => navigation.navigate('InternalBrowser', { url, title });

  if (validating) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: currentTheme.backgroundColor }]}>
        <View style={styles.center}><ActivityIndicator size="large" color={currentTheme.primaryColor} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: currentTheme.backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}><Icon name="arrow-back" size={24} color={currentTheme.textColor} /></TouchableOpacity>
        <Text style={[styles.title_top, { color: currentTheme.textColor }]}>账号中心</Text>
        <View style={{ width: 24 }} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.status, { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor }]}>
          <Icon name={logged ? 'check-circle' : 'account-circle'} size={48} color={logged ? 'green' : currentTheme.placeholderColor} />
          <Text style={[styles.statusText, { color: currentTheme.textColor }]}>{logged ? `已登录：${user || 'AO3用户'}` : '未登录'}</Text>
          <Text style={[styles.statusSub, { color: currentTheme.placeholderColor }]}>{logged ? '登录状态已通过官方页面同步，收藏/历史/下载可用' : '请通过官方页面登录，可过人机验证'}</Text>
          {logged && <Text style={[styles.statusSub, { color: currentTheme.placeholderColor, marginTop: 6 }]}>若显示过期请点下方“官方登录”重新登录</Text>}
        </View>

        <Text style={[styles.section, { color: currentTheme.textColor }]}>官方操作（走 ECH 内部浏览器）</Text>
        <Card theme={currentTheme} title="官方登录 / 切换账号" desc="打开 archiveofourown.org/users/login，可过 Cloudflare 验证" onPress={() => open('https://archiveofourown.org/users/login', '官方登录')} primary />
        <Card theme={currentTheme} title="找回密码" desc="重置密码" onPress={() => open('https://archiveofourown.org/users/password/new', '找回密码')} />
        <Card theme={currentTheme} title="获取邀请" desc="申请新账号邀请码，查看排队人数" onPress={() => open('https://archiveofourown.org/invite_requests', '获取邀请')} />
        <Card theme={currentTheme} title="注册新号" desc="已有邀请码在此注册" onPress={() => open('https://archiveofourown.org/users/new', '注册')} />
        <Card theme={currentTheme} title="邀请排队查询" desc="输入邮箱查询当前位置" onPress={() => navigation.navigate('AccountCenter')} />

        <TouchableOpacity onPress={check} style={styles.refreshBtn}><Text style={{ color: currentTheme.primaryColor }}>刷新登录状态</Text></TouchableOpacity>
        <Text style={[styles.hint, { color: currentTheme.placeholderColor }]}>提示：原生登录框已移除，全部走官方页面，避免密码明文提交被拦截。登录后章节与下载会自动携带 Cookie。</Text>
      </ScrollView>
    </SafeAreaView>
  );
};

const Card = ({ theme, title, desc, onPress, primary }) => (
  <TouchableOpacity onPress={onPress} style={[styles.card, { backgroundColor: primary ? theme.primaryColor : theme.cardBackground, borderColor: theme.borderColor }]}>
    <Text style={[styles.cardTitle, { color: primary ? '#fff' : theme.textColor }]}>{title}</Text>
    <Text style={[styles.cardDesc, { color: primary ? 'rgba(255,255,255,0.85)' : theme.placeholderColor }]}>{desc}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  title_top: { fontSize: 17, fontWeight: '700' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 16 },
  status: { padding: 16, borderRadius: 12, borderWidth: 1, alignItems: 'center', marginBottom: 16 },
  statusText: { marginTop: 8, fontSize: 16, fontWeight: '600' },
  statusSub: { marginTop: 4, fontSize: 12, textAlign: 'center' },
  section: { fontSize: 14, fontWeight: '700', marginTop: 8, marginBottom: 10 },
  card: { padding: 14, borderRadius: 10, borderWidth: 1, marginBottom: 10 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardDesc: { fontSize: 12, marginTop: 4 },
  refreshBtn: { marginTop: 16, alignItems: 'center', padding: 10 },
  hint: { marginTop: 12, fontSize: 11, lineHeight: 16, textAlign: 'center' },
});
export default LoginScreen;
