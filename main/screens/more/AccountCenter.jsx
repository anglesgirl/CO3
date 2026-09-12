import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { AppContext } from '../../app';
import {
  deleteCredsToken,
  deleteCredsPasswd,
  hasUserCredentials,
} from '../../storage/Credentials';
import { getRealUsername, fetchAccountIdentity } from '../../web/account/accountIdentity';
import getUrl from '../../web/requestManager';
import { openEchBrowser, onEchLoginSuccess } from '../../components/EchBrowser';

/**
 * 账号中心。
 *
 * 【这个版本从哪来】按用户要求，照 `fork/go-ech-minimal` 的那版重建
 * （用户："把 AccountCenter 按 go-ech-minimal 那个重建（登录/找回密码/邀请/激活，功能更全）"），
 * 界面与功能保持一致；**底层调用已全部换成当前架构**，原版依赖的
 * `web/echKy`（echFetch/clearAuthCookies）与 `fetchViaWebView(interactiveLogin)`
 * 在当前分支都不存在了，直接照抄会编不过。
 *
 * 关键差异（照搬时必须改的）：
 *  - 登录：原版 `fetchViaWebView(..., {interactiveLogin:true})` 取 session；
 *    现在改为**打开应用内 ECH 浏览器加载官方登录页**（原生 EchWebView 内部
 *    已做登录劫持与成功检测），用户登录完返回本页，`useFocusEffect` 会
 *    自动重新校验 Cookie 并同步真实用户名。
 *  - 登出：原版还调 `clearAuthCookies()`；当前 `deleteCredsToken()` 内部
 *    已经 `CookieManager.clearAll()`，不需要额外调用。
 *  - 用户名：一律走 `getRealUsername()`（**不是**存储里的原值 ——
 *    邮箱登录时存储里是邮箱，用它拼 /users/<x>/... 会 404）。
 *  - 取页面：`echFetch` → `getUrl`。
 *
 * 另外补了两个用户常用的入口（我的书签 / 稍后阅读）：这两条路径都必须用
 * `getRealUsername()` 拼地址，否则又是 404（老 bug 就是这个）。
 */
export default function AccountCenter() {
  const { currentTheme } = useContext(AppContext);
  const { t } = useTranslation();

  const [user, setUser] = useState('');
  const [logged, setLogged] = useState(false);
  const [validating, setValidating] = useState(true);
  const [queue, setQueue] = useState({ total: null, rate: null, loading: false, failed: false });
  const [email, setEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [activateLink, setActivateLink] = useState('');

  const refresh = useCallback(async () => {
    setValidating(true);
    try {
      // 登录态判据 = Cookie 里的 user_credentials（见 storage/Credentials.hasUserCredentials 注释）
      const ok = await hasUserCredentials();
      setLogged(ok);
      if (ok) {
        // 真实用户名（邮箱/脏数据会在这里自愈成权威值，并顺手把存储改正）
        const real = await getRealUsername().catch(() => null);
        setUser(real || '');
        // 顺带把 pseud 也补上，供书签/稍后读按 pseud 取用
        await fetchAccountIdentity().catch(() => null);
      } else {
        setUser('');
      }
    } catch {
      setLogged(false);
    } finally {
      setValidating(false);
    }
  }, []);

  const fetchQueue = useCallback(async () => {
    setQueue((s) => ({ ...s, loading: true, failed: false }));
    try {
      const html = await getUrl('https://archiveofourown.org/invite_requests', false);
      const text = typeof html === 'string' ? html : '';
      // AO3 的实际文案（2026-09 用真实账号在服务器实测，不是猜的）：
      //   "There are currently 262463 people on the waiting list."
      //   "We are sending out 5000 invitations every 6 hours."
      // 旧正则写的是 "... people in the queue" —— AO3 早已改词成 waiting list，
      // 所以永远匹配不到，表现为"排队人数获取失败"。
      // 另外 AO3 **不再提供"你排第几"**（页面里没有 you are number X），
      // 相应的个人位置展示已去掉，改为显示发放速度。
      const m1 =
        text.match(/There are currently\s+([\d,]+)\s+people on the waiting list/i) ||
        text.match(/There are\s+([\d,]+)\s+people\s+(?:in|on)\s+the\s+(?:queue|waiting list)/i);
      const m2 = text.match(/sending out\s+([\d,]+)\s+invitations every\s+(\d+)\s+hours/i);
      setQueue({
        total: m1 ? m1[1].replace(/,/g, '') : null,
        rate: m2 ? `${m2[1]} / ${m2[2]}h` : null,
        loading: false,
        failed: !m1,
      });
    } catch (e) {
      setQueue((s) => ({ ...s, loading: false, failed: true }));
    }
  }, []);

  // 进页面就刷新登录状态**并加载排队人数**。
  //（用户反馈"底部排队没显示"：原实现要手动点"刷新排队"才有数据，
  //  一进来看到的是占位文案，看起来就像功能没做。）
  useEffect(() => {
    refresh();
    fetchQueue();
  }, [refresh, fetchQueue]);

  // 从登录页/应用内浏览器返回时自动刷新登录状态
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  // 登录成功（原生 EchWebView 的 LoginSuccess 事件）——
  // 宿主会自动关掉浏览器，这里同步把账号中心刷成已登录状态。
  useEffect(() => onEchLoginSuccess(() => refresh()), [refresh]);

  /** 打开官方登录页：原生 EchWebView 负责劫持登录表单并检测成功，回来时 refresh 同步。 */
  const doLogin = () => {
    openEchBrowser('https://archiveofourown.org/users/login');
  };

  const open = (url) => {
    openEchBrowser(url);
  };

  /** 我自己的页面链接一律用真实用户名拼，避免邮箱 404。 */
  const openMine = async (path) => {
    const real = await getRealUsername().catch(() => null);
    if (!real) {
      Alert.alert(t('screen_account_login_failed'), t('screen_account_center_login_hint'));
      return;
    }
    open(`https://archiveofourown.org/users/${real}/${path}`);
  };

  const Card = ({ title, desc, onPress }) => (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.card,
        { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor },
      ]}
    >
      <Text style={[styles.cardTitle, { color: currentTheme.textColor }]}>{title}</Text>
      <Text style={[styles.cardDesc, { color: currentTheme.placeholderColor }]}>{desc}</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: currentTheme.backgroundColor }]}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <Text style={[styles.header, { color: currentTheme.textColor }]}>
          {t('screen_account_center_title')}
        </Text>

        <View
          style={[
            styles.status,
            { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor },
          ]}
        >
          {validating ? (
            <ActivityIndicator />
          ) : (
            <>
              <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>
                {logged
                  ? t('screen_account_center_logged_in', { username: user || 'AO3' })
                  : t('screen_account_center_not_logged_in')}
              </Text>
              <Text style={{ color: currentTheme.placeholderColor, marginTop: 4 }}>
                {logged
                  ? t('screen_account_center_available')
                  : t('screen_account_center_login_hint')}
              </Text>
            </>
          )}
        </View>

        {!logged && (
          <View
            style={[
              styles.queueBox,
              {
                backgroundColor: currentTheme.cardBackground,
                borderColor: currentTheme.borderColor,
                marginBottom: 10,
              },
            ]}
          >
            <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>
              {t('screen_account_center_login_ao3')}
            </Text>
            <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
              {t('screen_account_center_login_desc')}
            </Text>
            <TouchableOpacity
              onPress={doLogin}
              style={[styles.btn, { backgroundColor: currentTheme.primaryColor }]}
            >
              <Text style={styles.btnText}>{t('screen_account_center_go_login')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {logged && (
          <TouchableOpacity
            onPress={() => {
              Alert.alert(
                t('screen_account_center_logout'),
                t('screen_account_center_logout_confirm'),
                [
                  { text: t('common_cancel'), style: 'cancel' },
                  {
                    text: t('screen_account_center_logout'),
                    style: 'destructive',
                    onPress: async () => {
                      await deleteCredsToken().catch(() => {});
                      await deleteCredsPasswd().catch(() => {});
                      setLogged(false);
                      setUser('');
                      refresh();
                    },
                  },
                ],
              );
            }}
            style={[styles.btn, { backgroundColor: currentTheme.primaryColor, marginBottom: 10 }]}
          >
            <Text style={styles.btnText}>{t('screen_account_center_logout')}</Text>
          </TouchableOpacity>
        )}

        <Text style={[styles.section, { color: currentTheme.textColor }]}>
          {t('screen_account_center_quick')}
        </Text>
        <Card
          title={t('screen_account_center_my_bookmarks')}
          desc={t('screen_account_center_my_bookmarks_desc')}
          onPress={() => openMine('bookmarks')}
        />
        <Card
          title={t('screen_account_center_my_readlater')}
          desc={t('screen_account_center_my_readlater_desc')}
          onPress={() => openMine('readings?show=to-read')}
        />
        <Card
          title={t('screen_account_center_forgot')}
          desc={t('screen_account_center_forgot_desc')}
          onPress={() => open('https://archiveofourown.org/users/password/new')}
        />
        <Card
          title={t('screen_account_center_invite')}
          desc={t('screen_account_center_invite_desc')}
          onPress={() => open('https://archiveofourown.org/invite_requests')}
        />

        <View
          style={[
            styles.queueBox,
            {
              backgroundColor: currentTheme.cardBackground,
              borderColor: currentTheme.borderColor,
              marginBottom: 10,
            },
          ]}
        >
          <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>
            {t('screen_account_center_paste_invite')}
          </Text>
          <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
            {t('screen_account_center_paste_invite_desc')}
          </Text>
          <View style={{ flexDirection: 'row', marginTop: 10 }}>
            <TextInput
              placeholder="https://archiveofourown.org/...invitation_token=xxx"
              placeholderTextColor={currentTheme.placeholderColor}
              value={inviteLink}
              onChangeText={setInviteLink}
              style={[
                styles.input,
                { borderColor: currentTheme.borderColor, color: currentTheme.textColor },
              ]}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              onPress={() => {
                let url = inviteLink.trim();
                if (!url) return Alert.alert(t('screen_account_center_paste_empty'));
                const m = url.match(/invitation_token=([^&\s]+)/);
                if (m) url = `https://archiveofourown.org/users/new?invitation_token=${m[1]}`;
                else if (!url.startsWith('http')) {
                  url = `https://archiveofourown.org/users/new?invitation_token=${url}`;
                }
                open(url);
              }}
              style={[styles.btnSmall, { backgroundColor: currentTheme.primaryColor }]}
            >
              <Text style={styles.btnText}>{t('screen_account_center_open')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View
          style={[
            styles.queueBox,
            {
              backgroundColor: currentTheme.cardBackground,
              borderColor: currentTheme.borderColor,
              marginBottom: 10,
            },
          ]}
        >
          <Text style={{ color: currentTheme.textColor, fontWeight: '600' }}>
            {t('screen_account_center_paste_activate')}
          </Text>
          <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
            {t('screen_account_center_paste_activate_desc')}
          </Text>
          <View style={{ flexDirection: 'row', marginTop: 10 }}>
            <TextInput
              placeholder="https://archiveofourown.org/users/confirmation..."
              placeholderTextColor={currentTheme.placeholderColor}
              value={activateLink}
              onChangeText={setActivateLink}
              style={[
                styles.input,
                { borderColor: currentTheme.borderColor, color: currentTheme.textColor },
              ]}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              onPress={() => {
                const url = activateLink.trim();
                if (!url) return Alert.alert(t('screen_account_center_paste_empty'));
                open(url);
              }}
              style={[styles.btnSmall, { backgroundColor: currentTheme.primaryColor }]}
            >
              <Text style={styles.btnText}>{t('screen_account_center_open')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text style={[styles.section, { color: currentTheme.textColor }]}>
          {t('screen_account_center_queue_title')}
        </Text>
        <View
          style={[
            styles.queueBox,
            { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor },
          ]}
        >
          {queue.loading ? (
            <ActivityIndicator />
          ) : (
            <>
              <Text style={{ color: currentTheme.textColor }}>
                {queue.failed
                  ? t('screen_account_center_queue_failed')
                  : t('screen_account_center_queue_total', {
                      total: queue.total ?? t('screen_account_center_queue_unknown'),
                    })}
              </Text>
              {queue.rate ? (
                <Text style={{ color: currentTheme.textColor, marginTop: 6 }}>
                  {t('screen_account_center_queue_rate', { rate: queue.rate })}
                </Text>
              ) : null}
              <TouchableOpacity
                onPress={fetchQueue}
                style={[styles.btn, { backgroundColor: currentTheme.primaryColor }]}
              >
                <Text style={styles.btnText}>{t('screen_account_center_queue_refresh')}</Text>
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', marginTop: 12 }}>
                <TextInput
                  placeholder={t('screen_account_center_queue_email')}
                  placeholderTextColor={currentTheme.placeholderColor}
                  value={email}
                  onChangeText={setEmail}
                  style={[
                    styles.input,
                    { borderColor: currentTheme.borderColor, color: currentTheme.textColor },
                  ]}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                <TouchableOpacity
                  onPress={() => {
                    if (!email.includes('@')) return Alert.alert(t('screen_account_center_queue_bad_email'));
                    open(
                      `https://archiveofourown.org/invite_requests?email=${encodeURIComponent(email)}`,
                    );
                  }}
                  style={[styles.btnSmall, { backgroundColor: currentTheme.primaryColor }]}
                >
                  <Text style={styles.btnText}>{t('screen_account_center_query')}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>

        <TouchableOpacity onPress={refresh} style={{ marginTop: 20, alignItems: 'center' }}>
          <Text style={{ color: currentTheme.primaryColor }}>
            {t('screen_account_center_refresh_state')}
          </Text>
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
