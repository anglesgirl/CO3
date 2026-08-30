import React, { useContext, useEffect, useState, useCallback } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View, NativeModules } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppContext } from '../../app';
import { getUsername, getCredsToken, setCredsToken } from '../../storage/Credentials';
import { validateCookie } from '../../web/account/login';

const LoginScreen = () => {
  const { currentTheme } = useContext(AppContext);
  const navigation = useNavigation();
  const [user, setUser] = useState('');
  const [logged, setLogged] = useState(false);
  const [validating, setValidating] = useState(true);
  const [debug, setDebug] = useState('');

  const check = useCallback(async () => {
    setValidating(true);
    try {
      const u = await getUsername();
      setUser(u || '');
      // 1) 优先用原生 webkit CookieManager 直读（能读到 HttpOnly），但必须真校验
      try {
        const mod = NativeModules.CoCookieModule;
        if (mod && mod.getCookie) {
          const cookie = await mod.getCookie('https://archiveofourown.org/').catch(()=> '');
          setDebug(cookie ? cookie.slice(0,140) : 'empty');
          const m = cookie.match(/_otwarchive_session=([^;]+)/);
          const token = m ? decodeURIComponent(m[1]) : null;
          // 匿名也会有 session，必须走网络校验；token 为空则直接未登录
          if (token) {
            // 同步到 Keychain
            try { await setCredsToken(token); } catch {}
            const ok = await validateCookie(token).catch(() => false);
            if (ok) { setLogged(true); setValidating(false); return; }
            // 校验失败则视为未登录，继续走回落
          }
        }
      } catch (e) { setDebug('native err:'+String(e).slice(0,60)); }
      // 2) 回落旧逻辑
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
          <Text style={[styles.statusSub, { color: currentTheme.placeholderColor }]}>{logged ? '官方页面登录已同步，章节/下载可用' : '请通过官方页面登录，可过人机验证'}</Text>
          {!!debug && <Text style={[styles.statusSub, { color: currentTheme.placeholderColor, fontSize:10, marginTop:6 }]} numberOfLines={2}>cookie: {debug}</Text>}
        </View>

        <Text style={[styles.section, { color: currentTheme.textColor }]}>官方操作（ECH 内部浏览器）</Text>
        <Card theme={currentTheme} title="官方登录 / 切换账号" desc="archiveofourown.org/users/login" onPress={() => open('https://archiveofourown.org/users/login', '官方登录')} primary />
        <Card theme={currentTheme} title="找回密码" desc="重置密码" onPress={() => open('https://archiveofourown.org/users/password/new', '找回密码')} />
        <Card theme={currentTheme} title="获取邀请" desc="申请邀请码/查看排队" onPress={() => open('https://archiveofourown.org/invite_requests', '获取邀请')} />
        <Card theme={currentTheme} title="粘贴邀请链接注册" desc="粘贴官方邀请邮件链接，跳注册页" onPress={() => {
          // 复用 AccountCenter 的粘贴逻辑：弹输入后跳 InternalBrowser
          navigation.navigate('AccountCenter', { focus: 'invite' });
        }} />
        <Card theme={currentTheme} title="粘贴激活链接" desc="粘贴激活邮件链接，完成激活" onPress={() => {
          navigation.navigate('AccountCenter', { focus: 'activate' });
        }} />
        <Card theme={currentTheme} title="邀请排队查询" desc="邮箱查位置" onPress={() => navigation.navigate('AccountCenter')} />

        <TouchableOpacity onPress={check} style={styles.refreshBtn}><Text style={{ color: currentTheme.primaryColor }}>刷新登录状态</Text></TouchableOpacity>
        <Text style={[styles.hint, { color: currentTheme.placeholderColor }]}>原生登录框已移除，全部走官方页面。登录后若仍显示未登录，点“刷新”或重新进官方登录页。</Text>
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
