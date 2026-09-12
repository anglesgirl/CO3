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
import { queryInviteQueue } from '../../web/account/inviteQueue';
import { requestPasswordReset } from '../../web/account/passwordReset';
import { fetchRegisterForm, submitRegister, activateByLink, AO3 } from '../../web/account/inviteFlow';
import { submitInviteRequest, getCooldownLeft } from '../../web/account/inviteRequest';
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
  // 注册：字段与值都来自 AO3 注册页的实际表单（不写死字段名）
  const [regFields, setRegFields] = useState([]);
  const [regValues, setRegValues] = useState({});
  const [regLoading, setRegLoading] = useState(false);
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [regResult, setRegResult] = useState(null);
  const [actLoading, setActLoading] = useState(false);
  const [actResult, setActResult] = useState(null);
  // 申请邀请（排队）—— 含"被繁忙后自我暂停"的冷却状态
  const [reqEmail, setReqEmail] = useState('');
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqResult, setReqResult] = useState(null);
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

  const regFallbackUrl = () => normalizeInviteUrl(inviteLink);

  /**
   * 应用内拉取注册页 → 按页面真实字段渲染窗体。
   * 用户要求："不走网页模式，而是app本体，这样没那么大割裂感"；
   * 只有 app 真的做不到（例如人机验证）才回退浏览器。
   */
  const doLoadRegisterForm = async () => {
    const url = normalizeInviteUrl(inviteLink);
    if (!url) return Alert.alert(t('screen_account_center_paste_empty'));
    setRegLoading(true);
    setRegResult(null);
    setRegFields([]);
    try {
      const r = await fetchRegisterForm(url.replace(/^.*invitation_token=/, ''));
      if (!r.ok) {
        setRegResult({ ok: false, message: r.message });
        return;
      }
      setRegFields(r.fields);
      setRegResult(null);
    } catch (e) {
      setRegResult({ ok: false, message: e.message });
    } finally {
      setRegLoading(false);
    }
  };

  const doSubmitRegister = async () => {
    setRegSubmitting(true);
    setRegResult(null);
    try {
      const url = normalizeInviteUrl(inviteLink);
      const form = await fetchRegisterForm(url.replace(/^.*invitation_token=/, ''));
      if (!form.ok) {
        setRegResult({ ok: false, message: form.message });
        return;
      }
      const r = await submitRegister({
        action: form.action,
        token: form.token,
        fields: form.fields,
        values: regValues,
      });
      setRegResult(r);
    } catch (e) {
      setRegResult({ ok: false, message: e.message });
    } finally {
      setRegSubmitting(false);
    }
  };

  /**
   * 提交"申请邀请"。**只提交一次，绝不做任何自动重试。**
   * 用户明确要求："提交被繁忙以后，直接帮官方暂停，需要等至少5分钟以后再提交，
   * 要不然我们就成了攻击官方的工具了。"
   * 所以这里既没有 while 也没有递归 —— 何时再试由人决定，不由代码替用户决定。
   */
  const doSubmitInviteRequest = async () => {
    const emailClean = reqEmail.trim();
    if (!emailClean || !emailClean.includes('@')) {
      Alert.alert(t('screen_account_center_queue_bad_email'));
      return;
    }
    if (reqCooldownLeft > 0) return; // 冷却期内连请求都不发
    setReqSubmitting(true);
    setReqResult(null);
    try {
      const r = await submitInviteRequest(emailClean);
      setReqResult(r);
      if (r.waitMs) setReqCooldownLeft(r.waitMs);
    } catch (e) {
      setReqResult({ ok: false, message: e.message });
    } finally {
      setReqSubmitting(false);
    }
  };

  /** 激活：链接本身是 GET，应用内直接请求（不打开任何浏览器）。 */
  const doActivate = async () => {
    const url = activateLink.trim();
    if (!url) return Alert.alert(t('screen_account_center_paste_empty'));
    setActLoading(true);
    setActResult(null);
    try {
      const r = await activateByLink(url);
      setActResult(r);
    } catch (e) {
      setActResult({ ok: false, message: e.message });
    } finally {
      setActLoading(false);
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

  const open = (url) => {
    openEchBrowser(url);
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
              onPress={doLoadRegisterForm}
              style={[styles.btnInline, { backgroundColor: currentTheme.primaryColor }]}
            >
              {regLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnText}>{t('screen_account_center_open')}</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* 注册表单：字段按 AO3 页面实际内容动态生成（不写死字段名） */}
          {regFields.length > 0 ? (
            <View style={{ marginTop: 10 }}>
              {regFields.map((f) => (
                <TextInput
                  key={f.name}
                  placeholder={f.label}
                  placeholderTextColor={currentTheme.placeholderColor}
                  value={regValues[f.name] || ''}
                  onChangeText={(v) => setRegValues((s) => ({ ...s, [f.name]: v }))}
                  secureTextEntry={f.type === 'password'}
                  style={[
                    styles.input,
                    {
                      borderColor: currentTheme.borderColor,
                      color: currentTheme.textColor,
                      marginTop: 8,
                    },
                  ]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              ))}
              <TouchableOpacity
                onPress={doSubmitRegister}
                style={[
                  styles.btnInline,
                  { backgroundColor: currentTheme.primaryColor, marginTop: 10, alignSelf: 'flex-start', marginLeft: 0 },
                ]}
              >
                {regSubmitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.btnText}>{t('screen_account_center_submit')}</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}

          {regResult ? (
            <Text style={{ color: currentTheme.textColor, marginTop: 8, fontSize: 12 }}>
              {regResult.ok
                ? t('screen_account_center_register_done')
                : regResult.detail || t('screen_account_center_register_failed')}
            </Text>
          ) : null}

          {/* 兜底：app 提交拿不到结果（人机验证/令牌失效等）时，才提供"改用浏览器打开" */}
          {regResult && !regResult.ok ? (
            <TouchableOpacity
              onPress={() => open(regFallbackUrl())}
              style={{ marginTop: 8, alignSelf: 'flex-start' }}
            >
              <Text style={{ color: currentTheme.primaryColor, fontSize: 12 }}>
                {t('screen_account_center_use_browser')}
              </Text>
            </TouchableOpacity>
          ) : null}
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
              onPress={doActivate}
              style={[styles.btnInline, { backgroundColor: currentTheme.primaryColor }]}
            >
              {actLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnText}>{t('screen_account_center_open')}</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* 激活链接本身就是一个 GET（访问即生效），app 内直接请求即可，
              不需要窗体，也不需要打开浏览器。 */}
          {actResult ? (
            <Text style={{ color: currentTheme.textColor, marginTop: 8, fontSize: 12 }}>
              {actResult.ok
                ? actResult.message === 'already'
                  ? t('screen_account_center_activate_already')
                  : t('screen_account_center_activate_done')
                : t('screen_account_center_activate_failed')}
            </Text>
          ) : null}

          {/* 兜底：链路里出现人机验证等 app 处理不了的情况，才让用户走浏览器 */}
          {actResult && !actResult.ok ? (
            <TouchableOpacity
              onPress={() => {
                const u = activateLink.trim();
                if (!u) return Alert.alert(t('screen_account_center_paste_empty'));
                open(u);
              }}
              style={{ marginTop: 8, alignSelf: 'flex-start' }}
            >
              <Text style={{ color: currentTheme.primaryColor, fontSize: 12 }}>
                {t('screen_account_center_use_browser')}
              </Text>
            </TouchableOpacity>
          ) : null}
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
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 } }>
            <TextInput
              placeholder={t('screen_account_center_request_email')}
              placeholderTextColor={currentTheme.placeholderColor}
              value={reqEmail}
              onChangeText={setReqEmail}
              editable={reqCooldownLeft === 0}
              style={[
                styles.input,
                { borderColor: currentTheme.borderColor, color: currentTheme.textColor },
              ]}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TouchableOpacity
              onPress={doSubmitInviteRequest}
              disabled={reqSubmitting || reqCooldownLeft > 0}
              style={[
                // 行内按钮用 btnInline（与输入框同高 44）—— 之前误用了全宽样式 btn
                //（带 marginTop 12 / 高 46），在横向排列里既错位又差 2px 高度。
                // ⚠️ 这里**不能加 marginTop**：它在 flexDirection:'row' 里，会把按钮整体下移，
                // 与输入框错开（用户反馈"按钮和框没有对齐"）。行与行之间的间距由父 View 的
                // marginTop 负责。
                styles.btnInline,
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
          </View>
          {reqResult ? (
            <Text style={{ color: currentTheme.textColor, marginTop: 8, fontSize: 12 }}>
              {reqResult.ok
                ? t('screen_account_center_request_done')
                : reqResult.message === 'busy'
                ? t('screen_account_center_request_busy')
                : reqResult.message === 'cooldown'
                ? t('screen_account_center_request_wait', {
                    time: formatCountdown(reqResult.waitMs || 0),
                  })
                : reqResult.detail || t('screen_account_center_request_failed')}
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
