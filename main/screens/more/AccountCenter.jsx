import { openEchBrowser } from '../../components/EchBrowser';
import React, { useState, useEffect, useContext, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import InAppBrowser from 'react-native-inappbrowser-reborn';
import { AppContext } from '../../app';
import {
  getCredsToken,
  deleteCredsToken,
  deleteCredsPasswd,
} from '../../storage/Credentials';
import { validateCookie } from '../../web/account/login';
import { getRealUsername, fetchAccountIdentity } from '../../web/account/accountIdentity';
import getUrl from '../../web/requestManager';

/**
 * 账号中心（我们自己的版本，替代作者原版）
 *
 * 与原版/历史版的区别：
 * 1. 显示的账号名来自 fetchAccountIdentity —— 从 AO3 页面取**真实 username**，
 *    用户名用邮箱登录时也不会再把邮箱当用户名（原版的老 bug，曾导致书签/稍后读全 404）。
 * 2. 所有请求走当前链路（OkHttp + Conscrypt 的 ECH 通道），不再依赖已删除的 echKy/JNI 模块。
 * 3. 登录复用已经验证可用的原生登录页（navigate('Login')），不做 WebView 套娃。
 */
export default function AccountCenter() {
  const { currentTheme } = useContext(AppContext);
  const navigation = useNavigation();
  const [user, setUser] = useState('');
  const [pseud, setPseud] = useState('');
  const [logged, setLogged] = useState(false);
  const [validating, setValidating] = useState(true);
  const [queue, setQueue] = useState({ total: null, myPos: null, loading: false });
  const [inviteLink, setInviteLink] = useState('');

  const refresh = useCallback(async () => {
    setValidating(true);
    try {
      const token = await getCredsToken();
      if (!token) {
        setLogged(false);
        setUser('');
        setPseud('');
        return;
      }
      const ok = await validateCookie(token).catch(() => false);
      setLogged(ok);
      if (ok) {
        const real = await getRealUsername().catch(() => null);
        setUser(real || '');
        const id = await fetchAccountIdentity().catch(() => null);
        setPseud((id && id.pseud) || '');
      } else {
        setUser('');
        setPseud('');
      }
    } catch (e) {
      setLogged(false);
    } finally {
      setValidating(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const openOfficial = async (url) => {
    try {
      if (await InAppBrowser.isAvailable()) {
        await openEchBrowser(url);
      } else {
        await Linking.openURL(url);
      }
    } catch (e) {
      Alert.alert('打开失败', e?.message || '网络异常');
    }
  };

  const fetchQueue = async () => {
    setQueue((s) => ({ ...s, loading: true }));
    try {
      const html = await getUrl('https://archiveofourown.org/invite_requests');
      const text = String(html || '');
      const totalMatch = text.match(/There are\s+(\d[\d,]*)\s+people\s+in\s+the\s+queue/i);
      const posMatch = text.match(/you\s+are\s+number\s*(\d+)/i);
      setQueue({
        total: totalMatch ? totalMatch[1] : null,
        myPos: posMatch ? posMatch[1] : null,
        loading: false,
      });
    } catch (e) {
      setQueue((s) => ({ ...s, loading: false }));
      Alert.alert('查询失败', e?.message || '网络异常，请稍后再试');
    }
  };

  const activateInvite = async () => {
    const raw = inviteLink.trim();
    if (!raw) return;
    const m = raw.match(/invitation_token=([A-Za-z0-9._-]+)/);
    const url = m
      ? `https://archiveofourown.org/users/new?invitation_token=${m[1]}`
      : raw.startsWith('http')
      ? raw
      : `https://archiveofourown.org/users/new?invitation_token=${raw}`;
    await openOfficial(url);
  };

  const doLogout = () => {
    Alert.alert('退出登录', '确认退出当前账号？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: async () => {
          await deleteCredsToken().catch(() => {});
          await deleteCredsPasswd().catch(() => {});
          setLogged(false);
          setUser('');
          setPseud('');
          refresh();
        },
      },
    ]);
  };

  const Card = ({ title, desc, onPress }) => (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.card,
        { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor },
      ]}>
      <Text style={[styles.cardTitle, { color: currentTheme.textColor }]}>{title}</Text>
      <Text style={[styles.cardDesc, { color: currentTheme.placeholderColor }]}>{desc}</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: currentTheme.backgroundColor }]}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <Text style={[styles.header, { color: currentTheme.textColor }]}>账号中心</Text>

        <View
          style={[
            styles.status,
            { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor },
          ]}>
          {validating ? (
            <ActivityIndicator color={currentTheme.primaryColor} />
          ) : (
            <>
              <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>
                {logged ? `已登录：${user || 'AO3 用户'}` : '未登录'}
              </Text>
              <Text style={{ color: currentTheme.placeholderColor, marginTop: 4 }}>
                {logged
                  ? pseud
                    ? `笔名：${pseud} · 收藏/书签/稍后阅读已同步`
                    : '收藏、书签、稍后阅读已可用'
                  : '登录后同步 AO3 数据'}
              </Text>
            </>
          )}
        </View>

        {!logged && (
          <TouchableOpacity
            onPress={() => navigation.push('Login', { currentTheme })}
            style={[styles.btn, { backgroundColor: currentTheme.primaryColor }]}>
            <Text style={styles.btnText}>去登录</Text>
          </TouchableOpacity>
        )}

        {logged && (
          <TouchableOpacity
            onPress={doLogout}
            style={[styles.btn, { backgroundColor: currentTheme.primaryColor, marginBottom: 10 }]}>
            <Text style={styles.btnText}>退出登录</Text>
          </TouchableOpacity>
        )}

        <Text style={[styles.section, { color: currentTheme.textColor }]}>快捷操作</Text>
        <Card
          title="找回密码"
          desc="重置 AO3 账号密码"
          onPress={() => openOfficial('https://archiveofourown.org/users/password/new')}
        />
        <Card
          title="获取邀请"
          desc="查看邀请排队状态 / 申请邀请码"
          onPress={() => openOfficial('https://archiveofourown.org/invite_requests')}
        />

        <View
          style={[
            styles.box,
            { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor },
          ]}>
          <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>排队查询</Text>
          <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
            查询 AO3 邀请队列人数与你的位置（走 ECH 通道）
          </Text>
          <TouchableOpacity
            onPress={fetchQueue}
            disabled={queue.loading}
            style={[styles.btn, { backgroundColor: currentTheme.primaryColor, marginTop: 10 }]}>
            {queue.loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnText}>立即查询</Text>
            )}
          </TouchableOpacity>
          {(queue.total || queue.myPos) && (
            <Text style={{ color: currentTheme.textColor, marginTop: 10 }}>
              {queue.total ? `队列人数：${queue.total}` : '未获取到队列人数'}
              {queue.myPos ? `\n你的位置：${queue.myPos}` : ''}
            </Text>
          )}
        </View>

        <View
          style={[
            styles.box,
            { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor },
          ]}>
          <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>粘贴邀请链接注册</Text>
          <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
            粘贴邀请邮件里的链接，自动提取 token 并打开注册页
          </Text>
          <TextInput
            style={[
              styles.input,
              {
                borderColor: currentTheme.borderColor,
                color: currentTheme.textColor,
                backgroundColor: currentTheme.backgroundColor,
              },
            ]}
            placeholder="https://archiveofourown.org/users/new?invitation_token=..."
            placeholderTextColor={currentTheme.placeholderColor}
            value={inviteLink}
            onChangeText={setInviteLink}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            onPress={activateInvite}
            style={[styles.btn, { backgroundColor: currentTheme.primaryColor }]}>
            <Text style={styles.btnText}>去注册</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { fontSize: 20, fontWeight: '700', marginBottom: 12 },
  status: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 12 },
  section: { fontSize: 14, fontWeight: '600', marginTop: 8, marginBottom: 8 },
  card: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 10 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardDesc: { fontSize: 12, marginTop: 4 },
  box: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 12, marginTop: 6 },
  btn: { borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginBottom: 10 },
  btnText: { color: '#fff', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 10,
    marginBottom: 10,
    fontSize: 13,
  },
});
