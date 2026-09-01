import React, { useState, useEffect, useContext } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { AppContext } from '../../app';
import { getUsername, getCredsToken, setCredsToken, setLastLogin, setUsernameOnly, deleteCredsToken, deleteCredsPasswd } from '../../storage/Credentials';
import { validateCookie, resolveAuthenticatedUsername } from '../../web/account/login';
import { fetchViaWebView } from '../../web/WebviewFetcher';
import { clearAuthCookies } from '../../web/echKy';

export default function AccountCenter() {
  const { currentTheme } = useContext(AppContext);
  const navigation = useNavigation();
  const [user, setUser] = useState('');
  const [logged, setLogged] = useState(false);
  const [validating, setValidating] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [queue, setQueue] = useState({ total: null, myPos: null, loading: false });
  const [email, setEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [activateLink, setActivateLink] = useState('');

  const refresh = async () => {
    setValidating(true);
    try {
      const u = await getUsername();
      setUser(u || '');
      const token = await getCredsToken();
      if (token) {
        const ok = await validateCookie(token).catch(() => false);
        setLogged(ok);
      } else setLogged(false);
    } catch { setLogged(false); } finally { setValidating(false); }
  };

  useEffect(() => { refresh(); }, []);
  useFocusEffect(React.useCallback(() => { refresh(); }, []));

  const doLogin = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const url = 'https://archiveofourown.org/users/login';
      const result = await fetchViaWebView(url, { interactiveLogin: true, translate: 'zh-CN' });
      const session = result?.session;
      if (!session) throw new Error('no session');
      await setCredsToken(session);
      await deleteCredsPasswd().catch(() => {});
      let accountUsername = null;
      const navMatch = String(result?.navigatedTo || '').match(/\/users\/([^\/?#]+)/);
      if (navMatch) accountUsername = decodeURIComponent(navMatch[1]);
      if (!accountUsername) accountUsername = await resolveAuthenticatedUsername(session).catch(() => null);
      if (accountUsername) await setUsernameOnly(accountUsername).catch(() => {});
      await setLastLogin().catch(() => {});
      Alert.alert('登录成功', '已同步登录状态');
      await refresh();
    } catch (e) {
      Alert.alert('登录失败', e?.message || '登录失败，请重试');
    } finally { setSubmitting(false); }
  };

  const fetchQueue = async () => {
    setQueue(s => ({ ...s, loading: true }));
    try {
      const { echFetch } = await import('../../web/echKy');
      const html = await echFetch('https://archiveofourown.org/invite_requests', { headers: { 'Accept': 'text/html' } }).then(r => r.text());
      let total = null;
      const m1 = html.match(/There are\s+(\d[\d,]*)\s+people\s+in\s+the\s+queue/i);
      if (m1) total = m1[1];
      let myPos = null;
      const m3 = html.match(/you\s+are\s+number\s*(\d+)/i);
      if (m3) myPos = m3[1];
      setQueue({ total, myPos, loading: false });
    } catch (e) {
      setQueue(s => ({ ...s, loading: false }));
    }
  };

  const open = async (url, title) => {
    try {
      await fetchViaWebView(url, { interactiveLogin: true, translate: 'zh-CN' });
    } catch (e) {
      Alert.alert('打开失败', e?.message || '网络异常');
    }
  };

  const Card = ({ title, desc, onPress }) => (
    <TouchableOpacity onPress={onPress} style={[styles.card, { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor }]}>
      <Text style={[styles.cardTitle, { color: currentTheme.textColor }]}>{title}</Text>
      <Text style={[styles.cardDesc, { color: currentTheme.placeholderColor }]}>{desc}</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: currentTheme.backgroundColor }]}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Text style={[styles.header, { color: currentTheme.textColor }]}>账号中心</Text>

      <View style={[styles.status, { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor }]}>
        {validating ? <ActivityIndicator /> : (
          <>
            <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>{logged ? `已登录：${user || 'AO3用户'}` : '未登录'}</Text>
            <Text style={{ color: currentTheme.placeholderColor, marginTop: 4 }}>{logged ? '可使用收藏、书签、稍后阅读' : '登录后同步 AO3 数据'}</Text>
          </>
        )}
      </View>

      {!logged && (
        <View style={[styles.queueBox, { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor, marginBottom: 10 }]}>
          <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>登录</Text>
          <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>使用 AO3 账号登录（被要求人机验证时自动转官方页）</Text>
          <TextInput
            placeholder="用户名"
            placeholderTextColor={currentTheme.placeholderColor}
            value={username}
            onChangeText={setUsername}
            style={[styles.input, { borderColor: currentTheme.borderColor, color: currentTheme.textColor, marginTop: 10 }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            placeholder="密码"
            placeholderTextColor={currentTheme.placeholderColor}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            style={[styles.input, { borderColor: currentTheme.borderColor, color: currentTheme.textColor, marginTop: 8 }]}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={doLogin}
          />
          <TouchableOpacity onPress={doLogin} disabled={submitting} style={[styles.btn, { backgroundColor: currentTheme.primaryColor }]}>
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>登录</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => open('https://archiveofourown.org/users/login', '官方登录')} style={{ marginTop: 8, alignItems: 'center' }}>
            <Text style={{ color: currentTheme.primaryColor, fontSize: 13 }}>官方页面登录（过人机验证）</Text>
          </TouchableOpacity>
        </View>
      )}
      {logged && (
        <TouchableOpacity
          onPress={() => {
            Alert.alert('退出登录', '确认退出当前账号？', [
              { text: '取消', style: 'cancel' },
              { text: '退出', style: 'destructive', onPress: async () => {
                  await deleteCredsToken().catch(() => {});
                  await deleteCredsPasswd().catch(() => {});
                  await clearAuthCookies().catch(() => {});
                  setLogged(false); setUser('');
                  refresh();
                } },
            ]);
          }}
          style={[styles.btn, { backgroundColor: currentTheme.primaryColor, marginBottom: 10 }]}
        >
          <Text style={styles.btnText}>退出登录</Text>
        </TouchableOpacity>
      )}

      <Text style={[styles.section, { color: currentTheme.textColor }]}>快捷操作</Text>
      <Card title="找回密码" desc="重置账号密码" onPress={() => open('https://archiveofourown.org/users/password/new', '找回密码')} />
      <Card title="获取邀请" desc="申请新账号邀请码" onPress={() => open('https://archiveofourown.org/invite_requests', '获取邀请')} />

      <View style={[styles.queueBox, { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor, marginBottom: 10 }]}>
        <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>粘贴邀请链接注册</Text>
        <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>粘贴官方邀请邮件中的链接，自动提取 token 跳注册页</Text>
        <View style={{ flexDirection: 'row', marginTop: 10 }}>
          <TextInput placeholder="https://archiveofourown.org/...invitation_token=xxx" placeholderTextColor={currentTheme.placeholderColor} value={inviteLink} onChangeText={setInviteLink} style={[styles.input, { borderColor: currentTheme.borderColor, color: currentTheme.textColor }]} autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity onPress={() => {
            let url = inviteLink.trim();
            if (!url) return Alert.alert('请粘贴邀请链接');
            const m = url.match(/invitation_token=([^&\s]+)/);
            if (m) url = `https://archiveofourown.org/users/new?invitation_token=${m[1]}`;
            else if (!url.startsWith('http')) url = `https://archiveofourown.org/users/new?invitation_token=${url}`;
            open(url, '注册');
          }} style={[styles.btnSmall, { backgroundColor: currentTheme.primaryColor }]}><Text style={styles.btnText}>打开</Text></TouchableOpacity>
        </View>
      </View>

      <View style={[styles.queueBox, { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor, marginBottom: 10 }]}>
        <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>粘贴激活链接</Text>
        <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>粘贴激活邮件链接，直接跳激活页</Text>
        <View style={{ flexDirection: 'row', marginTop: 10 }}>
          <TextInput placeholder="https://archiveofourown.org/users/confirmation..." placeholderTextColor={currentTheme.placeholderColor} value={activateLink} onChangeText={setActivateLink} style={[styles.input, { borderColor: currentTheme.borderColor, color: currentTheme.textColor }]} autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity onPress={() => {
            let url = activateLink.trim();
            if (!url) return Alert.alert('请粘贴激活链接');
            if (!url.startsWith('http')) url = url;
            open(url, '激活');
          }} style={[styles.btnSmall, { backgroundColor: currentTheme.primaryColor }]}><Text style={styles.btnText}>打开</Text></TouchableOpacity>
        </View>
      </View>

      <Text style={[styles.section, { color: currentTheme.textColor }]}>邀请排队</Text>
      <View style={[styles.queueBox, { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor }]}>
        {queue.loading ? <ActivityIndicator /> : (
          <>
            <Text style={{ color: currentTheme.textColor }}>当前排队人数：{queue.total ?? '—（未匹配到官方文案，点击刷新）'}</Text>
            <Text style={{ color: currentTheme.textColor, marginTop: 6 }}>我的位置：{queue.myPos ?? '未查询（提交邀请后显示）'}</Text>
            <TouchableOpacity onPress={fetchQueue} style={[styles.btn, { backgroundColor: currentTheme.primaryColor }]}>
              <Text style={styles.btnText}>刷新排队</Text>
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', marginTop: 12 }}>
              <TextInput
                placeholder="输入申请邮箱查询"
                placeholderTextColor={currentTheme.placeholderColor}
                value={email}
                onChangeText={setEmail}
                style={[styles.input, { borderColor: currentTheme.borderColor, color: currentTheme.textColor }]}
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <TouchableOpacity
                onPress={() => {
                  if (!email.includes('@')) return Alert.alert('请输入有效邮箱');
                  open(`https://archiveofourown.org/invite_requests?email=${encodeURIComponent(email)}`, '查询位置');
                }}
                style={[styles.btnSmall, { backgroundColor: currentTheme.primaryColor }]}
              >
                <Text style={styles.btnText}>查询</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

      <TouchableOpacity onPress={refresh} style={{ marginTop: 20, alignItems: 'center' }}>
        <Text style={{ color: currentTheme.primaryColor }}>刷新状态</Text>
      </TouchableOpacity>
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { fontSize: 22, fontWeight: '700', marginBottom: 12 },
  status: { padding: 14, borderRadius: 10, borderWidth: 1, marginBottom: 16 },
  section: { fontSize: 15, fontWeight: '600', marginTop: 12, marginBottom: 8 },
  card: { padding: 14, borderRadius: 10, borderWidth: 1, marginBottom: 10 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardDesc: { fontSize: 12, marginTop: 4 },
  queueBox: { padding: 14, borderRadius: 10, borderWidth: 1 },
  btn: { marginTop: 10, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  btnSmall: { marginLeft: 8, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '600' },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, height: 40 },
});
