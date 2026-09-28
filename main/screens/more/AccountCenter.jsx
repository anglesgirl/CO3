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
  deletePseudOnly,
  hasUserCredentials,
} from '../../storage/Credentials';
import { getRealUsername, fetchAccountIdentity, clearIdentityCache } from '../../web/account/accountIdentity';
import { queryInviteQueue } from '../../web/account/inviteQueue';
import { requestPasswordReset } from '../../web/account/passwordReset';
import { AO3 } from '../../web/account/inviteFlow';
import { markInviteRequestOpened, getCooldownLeft } from '../../web/account/inviteRequest';
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
  const [querying, setQuerying] = useState(false);
  const [queryResult, setQueryResult] = useState(null);
  const [pwEmail, setPwEmail] = useState('');
  const [pwSending, setPwSending] = useState(false);
  const [pwResult, setPwResult] = useState(null);
  // 申请邀请（排队）—— 含"被繁忙后自我暂停"的冷却状态
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqCooldownLeft, setReqCooldownLeft] = useState(0);

  /** 毫秒 → "4分32秒"（冷却倒计时用）。 */
  const formatCountdown = (ms) => {
    const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
    const m = Math.floor(total / 60);
    return m > 0 ? `${m}分${total % 60}秒` : `${total}秒`;
  };

  // 进页面先读一次冷却状态 —— 冷却写在本地存储里，**重启 app 也绕不过去**
  //（否则用户重启就能立刻再提交，自我限流形同虚设）。
  useEffect(() => {
    getCooldownLeft().then((left) => setReqCooldownLeft(left));
  }, []);

  // 冷却期间每秒递减；归零后按钮自动恢复
  useEffect(() => {
    if (reqCooldownLeft <= 0) return undefined;
    const timer = setInterval(() => {
      setReqCooldownLeft((prev) => (prev - 1000 > 0 ? prev - 1000 : 0));
    }, 1000);
    return () => clearInterval(timer);
    // 只在"从可提交变为冷却中"时建立定时器，避免每秒重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqCooldownLeft > 0]);

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

  /**
   * 用邮箱查询排队名次。
   * AO3 只在提交邮箱后返回"你排第几"；**不在排队中的邮箱没有名次**（用户说明），
   * 所以"查不到位置"要当成正常结果展示，而不是报错。
   */
  const doQueryQueue = async () => {
    if (!email || !email.includes('@')) {
      Alert.alert(t('screen_account_center_queue_bad_email'));
      return;
    }
    setQuerying(true);
    setQueryResult(null);
    try {
      const r = await queryInviteQueue(email);
      setQueryResult(r);
      // 顺手把总人数/发放速度补上（同一次请求带回来的）
      if (r && (r.total || r.rate)) {
        setQueue((s) => ({
          ...s,
          total: r.total || s.total,
          rate: r.rate || s.rate,
          loading: false,
          failed: !(r.total || s.total),
        }));
      }
    } catch (e) {
      setQueryResult({ ok: false, position: null, inQueue: false, message: e.message });
    } finally {
      setQuerying(false);
    }
  };

  /** 把用户粘的东西整理成一个可用的邀请链接（支持只粘 token 本身）。 */
  const normalizeInviteUrl = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/invitation_token=([^&\s]+)/);
    if (m) return `${AO3}/users/new?invitation_token=${m[1]}`;
    if (!s.startsWith('http')) return `${AO3}/users/new?invitation_token=${s}`;
    return s;
  };

  /**
   * 注册：不再用 App 内自建表单（AO3 风控会拦 App 表单提交，用户实测：
   * "注册、登录、激活，这里不应该使用APP表单的方式，风控很严重，不使用浏览器，
   * 它根本不让你操作"）。改为**和登录页一样**的方式：EchBrowser 打开官方注册页，
   * WebView 内走 ECH 通道 + Cloudflare 验证（登录能过，注册同样能过）。
   * 提交后页面返回结果 → 原生提取文本 → App 外小窗体翻译提示。
   */
  const doOpenRegister = () => {
    const url = normalizeInviteUrl(inviteLink);
    if (!url) return Alert.alert(t('screen_account_center_paste_empty'));
    openEchBrowser(url);
  };

  /**
   * 激活：改为 EchBrowser 打开激活链接页面（激活是 GET，访问即生效），
   * 页面结果由小窗体翻译提示。不再用 App 内直连请求（同样会被风控拦）。
   */
  const doOpenActivate = () => {
    const url = activateLink.trim();
    if (!url) return Alert.alert(t('screen_account_center_paste_empty'));
    openEchBrowser(url);
  };

  /**
   * 申请邀请（排队）：改为打开 AO3 排队页（EchBrowser，能过 CF 验证）。
   * 打开即记本地冷却（防滥用：用户要求"不成为攻击官方的工具"，AO3 页面
   * 自身还有 5 分钟倒计时，双保险）。提交后页面结果由小窗体翻译提示。
   */
  const doOpenInviteRequest = async () => {
    if (reqCooldownLeft > 0) return; // 冷却期内不开页面
    setReqSubmitting(true);
    try {
      await markInviteRequestOpened();
      setReqCooldownLeft(await getCooldownLeft());
      openEchBrowser(`${AO3}/invite_requests`);
    } finally {
      setReqSubmitting(false);
    }
  };

  /**
   * 应用内发起找回密码（自建窗体，不跳网页）。
   * 只在未登录时可用 —— 已登录时 AO3 直接 403（不允许已登录状态重置密码）。
   */
  const doResetPassword = async () => {
    if (!pwEmail || !pwEmail.includes('@')) {
      Alert.alert(t('screen_account_center_queue_bad_email'));
      return;
    }
    setPwSending(true);
    setPwResult(null);
    try {
      const r = await requestPasswordReset(pwEmail);
      setPwResult(r);
    } catch (e) {
      setPwResult({ ok: false, message: e.message });
    } finally {
      setPwSending(false);
    }
  };

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
                      await deletePseudOnly().catch(() => {});
                      clearIdentityCache();
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

        {/* 「快捷操作」整节已移除 —— 它只有"我的书签 / 稍后阅读"两个跳转，
            但外层「更多」菜单里本来就有 Bookmarks 与 ReadLater 两个 app 本体页面
            （More.jsx 里都有入口），属于纯重复。
            这两个入口是我重建账号中心时按"用户常用"的直觉加的，
            **当时没有先去查外层导航有没有**，还留下过"外层没有等价入口"这种
            没查就下的结论 —— 与"先查真实源码再改"的原则相悖，所以整节删掉。
            账号中心现在只保留它独有、外层没有的功能：
            登录/登出、找回密码、注册、激活、申请排队、排队查询。 */}
        {/* 「找回密码」已移到未登录区，并改为应用内自建窗体 ——
            已登录时 AO3 访问 /users/password/new 直接 403（不允许重置），
            而且用户要求"能用我们自己的窗体就用我们自己的窗体"。 */}

        {/* 以下都是"还没有账号/正准备注册"才需要的：获取邀请、用邀请链接注册、
            激活链接、邀请排队、找回密码。**已登录时全部隐藏** —— 已经有账号的人看这些
            毫无意义，还会把页面塞满（用户反馈："在已经登录的情况下，下面那些邀请注册，
            激活，都是没意义的，未登录才需要"）。 */}
        {!logged && (
          <>
            {/* 找回密码：应用内自建窗体，不跳网页 */}
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
                {t('screen_account_center_forgot')}
              </Text>
              <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
                {t('screen_account_center_forgot_desc')}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 } }>
                <TextInput
                  placeholder={t('screen_account_center_email_placeholder')}
                  placeholderTextColor={currentTheme.placeholderColor}
                  value={pwEmail}
                  onChangeText={setPwEmail}
                  style={[
                    styles.input,
                    { borderColor: currentTheme.borderColor, color: currentTheme.textColor },
                  ]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
                <TouchableOpacity
                  onPress={doResetPassword}
                  style={[styles.btnInline, { backgroundColor: currentTheme.primaryColor }]}
                >
                  {pwSending ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.btnText}>{t('screen_account_center_send')}</Text>
                  )}
                </TouchableOpacity>
              </View>
              {pwResult ? (
                <Text style={{ color: currentTheme.textColor, marginTop: 8, fontSize: 12 }}>
                  {pwResult.ok
                    ? t('screen_account_center_reset_sent')
                    : pwResult.message === 'email_not_found'
                    ? t('screen_account_center_reset_no_account')
                    : t('screen_account_center_reset_failed')}
                </Text>
              ) : null}
            </View>
            {/* 「获取邀请」原来跳网页 /invite_requests —— 下面的「邀请排队」区块
                已经用 app 本体展示了同一份数据（总人数/发放速度/我的名次），
                再跳一次网页属于重复，删掉。 */}

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
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 } }>
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
              onPress={doOpenRegister}
              style={[styles.btnInline, { backgroundColor: currentTheme.primaryColor }]}
            >
              <Text style={styles.btnText}>{t('screen_account_center_open')}</Text>
            </TouchableOpacity>
          </View>

          {/* 注册在 EchBrowser 内打开官方注册页完成（能过 Cloudflare 验证），
              提交后页面结果由 App 外小窗体翻译提示（见 EchBrowser 的翻译浮窗）。 */}
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
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 } }>
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
              onPress={doOpenActivate}
              style={[styles.btnInline, { backgroundColor: currentTheme.primaryColor }]}
            >
              <Text style={styles.btnText}>{t('screen_account_center_open')}</Text>
            </TouchableOpacity>
          </View>

          {/* 激活在 EchBrowser 内打开激活链接完成（访问即生效），
              页面结果由 App 外小窗体翻译提示。 */}
        </View>

        {/* 申请邀请（加入排队）—— 应用内提交，但**严格自我限流**。
            用户明确要求："提交被繁忙以后，直接帮官方暂停，需要等至少5分钟以后再提交，
            要不然我们就成了攻击官方的工具了。"
            所以：只发一次请求、绝不自动重试、被拒后按钮禁用并显示倒计时
            （冷却写在本地存储里，重启 app 也绕不过去）。 */}
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
            {t('screen_account_center_request_invite')}
          </Text>
          <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
            {t('screen_account_center_request_invite_desc')}
          </Text>
          {/* 排队改走 EchBrowser 打开 AO3 排队页（App 表单提交会被风控拦，
              网页能过 Cloudflare 验证）。打开即记本地冷却（防滥用，双保险）。 */}
          <TouchableOpacity
            onPress={doOpenInviteRequest}
            disabled={reqSubmitting || reqCooldownLeft > 0}
            style={[
              styles.btn,
              {
                backgroundColor:
                  reqCooldownLeft > 0 ? currentTheme.borderColor : currentTheme.primaryColor,
              },
            ]}
          >
            {reqSubmitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnText}>
                {reqCooldownLeft > 0
                  ? t('screen_account_center_request_wait', { time: formatCountdown(reqCooldownLeft) })
                  : t('screen_account_center_request_btn')}
              </Text>
            )}
          </TouchableOpacity>
          {reqCooldownLeft > 0 ? (
            <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 8 }}>
              {t('screen_account_center_request_cooldown_hint')}
            </Text>
          ) : null}
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
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 } }>
                <TextInput
                  placeholder={t('screen_account_center_query_email')}
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
                  onPress={doQueryQueue}
                  style={[
                    // 「查询」是辅助动作：用描边样式与上方的实心主按钮区分主次，
                    // 避免一屏多个高饱和实心蓝块互相抢视线（也是之前显"乱"的原因）。
                    styles.btnInlineOutline,
                    { borderColor: currentTheme.primaryColor },
                  ]}
                >
                  {querying ? (
                    <ActivityIndicator color={currentTheme.primaryColor} />
                  ) : (
                    <Text style={[styles.btnTextOutline, { color: currentTheme.primaryColor }]}>{t('screen_account_center_queue_query_btn')}</Text>
                  )}
                </TouchableOpacity>
              </View>
              {queryResult ? (
                <View style={{ marginTop: 10 }}>
                  <Text style={{ color: currentTheme.textColor }}>
                    {/* 三种状态的顺序很重要：
                        「邀请已发出」既没有名次、也不是"找不到"，必须优先判 —— 否则会被
                        误报成"未在排队"（用户已拿到邀请，却被说没排队）。 */}
                    {queryResult.invited
                      ? t('screen_account_center_queue_invited', { date: queryResult.invitedOn || '—' })
                      : queryResult.position
                      ? t('screen_account_center_queue_position', { pos: queryResult.position })
                      : queryResult.notFound
                      ? t('screen_account_center_queue_not_found')
                      : queryResult.inQueue
                      ? t('screen_account_center_queue_in_list')
                      : t('screen_account_center_queue_not_in_list')}
                  </Text>
                  {queryResult.eta ? (
                    <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
                      {t('screen_account_center_queue_eta', { eta: queryResult.eta })}
                    </Text>
                  ) : null}
                  {queryResult.canResend ? (
                    <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 4 }}>
                      {t('screen_account_center_queue_can_resend')}
                    </Text>
                  ) : null}
                  {/* 注意：不要再显示 total/rate —— 上面的「邀请排队」区块已经有全局的
                      排队总数与发放速度，这里重复显示会让用户以为是两个不同的数字。 */}
                </View>
              ) : null}
            </>
          )}
        </View>
          </>
        )}

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
  section: { fontSize: 15, fontWeight: '600', marginTop: 14, marginBottom: 8 },
  card: { padding: 16, borderRadius: 12, borderWidth: 1, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardDesc: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  queueBox: { padding: 16, borderRadius: 12, borderWidth: 1 },
  // 全宽主操作按钮
  btn: {
    height: 46,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  // 行内按钮：**必须与输入框同高**（原来是靠内容撑高，比 40px 的输入框矮一截，
  // 视觉上像"小色块嵌在大输入框里" —— 这是用户反馈"很丑"的主因）。
  btnInline: {
    height: 44,
    minWidth: 78,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
  },
  // 行内次要按钮（描边风格）—— 用来区分"查询"这类辅助动作，
  // 避免一屏多个实心高饱和蓝块互相抢视线。
  btnInlineOutline: {
    height: 44,
    minWidth: 78,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
    borderWidth: 1,
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  btnTextOutline: { fontWeight: '600', fontSize: 14 },
  // 输入框同样 44 高、圆角 10，与按钮对齐
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 14,
  },
});
