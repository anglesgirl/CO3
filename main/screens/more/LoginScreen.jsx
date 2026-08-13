import React, { useContext, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Clipboard,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { resolveAuthenticatedUsername, validateCookie } from '../../web/account/login';
import { clearAuthCookies } from '../../web/echKy';
import { fetchViaWebView } from '../../web/WebviewFetcher';
import {
  deleteCredsPasswd,
  deleteCredsToken,
  getCredsPasswd,
  getCredsToken,
  getUsername,
  setCredsToken,
  setLastLogin,
  setUsernameOnly,
} from '../../storage/Credentials';
import CustomAlert from '../../components/CustomAlert';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppContext } from '../../app';

// 账号相关操作（登录/注册/激活/忘记密码/获取邀请）全部在 WebView 打开
// AO3 官方页面完成 —— 客户端不再提供本地表单(2026-08-13 用户决定: 本地
// 表单全删, 点击按钮直接打开官方页面)。WebView 是真浏览器, CF 验证与
// 反钓鱼检查全部按官方流程走。
const LoginScreen = ({ route }) => {
  const { currentTheme } = useContext(AppContext);
  const navigation = useNavigation();

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [validating, setValidating] = useState(true);
  const [busy, setBusy] = useState(false);

  const [alert, setAlert] = useState({
    visible: false,
    title: '',
    message: '',
  });
  // 邀请/激活链接粘贴弹窗: { visible, type: 'signup'|'activate' }
  const [linkModal, setLinkModal] = useState({ visible: false, type: 'signup' });
  const [linkInput, setLinkInput] = useState('');
  const [linkDetected, setLinkDetected] = useState(false);
  const [sessionInfo, setSessionInfo] = useState({
    visible: false,
    username: '',
    password: '',
    hasStoredPassword: false,
  });

  const { t } = useTranslation();

  useEffect(() => {
    checkLoginStatus();
  }, []);

  const checkLoginStatus = async () => {
    try {
      setValidating(true);
      const storedToken = await getCredsToken();

      if (storedToken) {
        const isValid = await validateCookie(storedToken);
        setIsLoggedIn(isValid);
      } else {
        setIsLoggedIn(false);
      }
    } catch (error) {
      console.error('Token validation error:', error);
      setIsLoggedIn(false);
    } finally {
      setValidating(false);
    }
  };

  const showAlert = (title, message) => {
    setAlert({ visible: true, title, message });
  };

  const hideAlert = () => {
    setAlert({ ...alert, visible: false });
  };

  const formatStoredPassword = password => {
    if (!password || password.length === 0) return '';
    if (password.length === 1) return password + '*';
    if (password.length === 2) return password;

    const first = password.substring(0, 1);
    const last = password.charAt(password.length - 1);
    const middle = '*'.repeat(password.length - 2);

    return first + middle + last;
  };

  const showSessionInfo = async () => {
    try {
      const storedCreds = await getCredsPasswd();
      if (storedCreds) {
        setSessionInfo({
          visible: true,
          username: storedCreds.username,
          password: formatStoredPassword(storedCreds.password),
          hasStoredPassword: true,
        });
        return;
      }

      const usernameValue = await getUsername();
      setSessionInfo({
        visible: true,
        username: usernameValue,
        password: '',
        hasStoredPassword: false,
      });
    } catch (error) {
      console.error('Error retrieving session info:', error);
      showAlert(t('general_error'), t('screen_account_session_load_failed'));
    }
  };

  const hideSessionInfo = () => {
    setSessionInfo({
      visible: false,
      username: '',
      password: '',
      hasStoredPassword: false,
    });
  };

  // 打开官方页面（WebView，页面汉化注入）。登录页提交成功(302 离开 +
  // jar 轮询到 user_credentials)后自动存储 session 并刷新登录态——
  // **只存 session token 和用户名, 不存密码**；用户名优先从登录后的
  // 跳转 URL(/users/{username})提取, 主页解析失败也不阻塞登录。
  // 其他账号页面(注册/激活/忘记密码/邀请)由用户在官方页完成, 手动
  // 关闭 = 正常完成。urlOrPath 可以是完整链接(注册/激活)或路径。
  const openOfficial = async (urlOrPath, isLogin = false) => {
    setBusy(true);
    try {
      const url = urlOrPath.startsWith('http')
        ? urlOrPath
        : 'https://archiveofourown.org' + urlOrPath;
      const result = await fetchViaWebView(url, {
        interactiveLogin: true,
        translate: 'zh-CN',
      });
      if (isLogin) {
        const session = result?.session;
        if (!session) {
          throw new Error('Login failed: no session cookie after official login');
        }
        await setCredsToken(session);
        await deleteCredsPasswd().catch(() => {});
        // 用户名: 登录后跳转 URL 最可靠(日志实证 /users/anglesya),
        // 其次主页解析; 都失败则不存(书签路由用 getUsername 兜底)。
        let accountUsername = null;
        const navMatch = String(result?.navigatedTo || '').match(/\/users\/([^\/?#]+)/);
        if (navMatch) accountUsername = decodeURIComponent(navMatch[1]);
        if (!accountUsername) {
          accountUsername = await resolveAuthenticatedUsername(session).catch(() => null);
        }
        if (accountUsername) {
          await setUsernameOnly(accountUsername).catch(() => {});
        }
        await setLastLogin().catch(() => {});
        setIsLoggedIn(true);
        showAlert(t('general_success'), t('screen_account_login_success'));
      }
    } catch (error) {
      console.error('Official account flow error:', error?.message ?? error);
      showAlert(
        t('general_error'),
        isLogin
          ? t('screen_account_login_failed_generic')
          : t('screen_account_official_failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  // --- 邀请/激活链接粘贴弹窗 -------------------------------------------
  // AO3 官方链接特征: archiveofourown.org 域, 或 /signup /invitations /
  // /users/activate /users/new 路径, 或裸 token。
  const isAo3Link = s => {
    const t = String(s || '').trim();
    return (
      /archiveofourown\.org/i.test(t) ||
      /^\/(signup|invitations|users\/activate|users\/new)/i.test(t) ||
      /^[A-Za-z0-9_-]{10,}$/.test(t)
    );
  };

  // 把用户输入规范成完整 URL: 完整链接/裸域名/路径/裸 token 都支持。
  const normalizeLink = s => {
    let url = String(s || '').trim();
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (/^archiveofourown\.org/i.test(url)) return 'https://' + url;
    if (url.startsWith('/')) return 'https://archiveofourown.org' + url;
    if (/^[A-Za-z0-9_-]{10,}$/.test(url)) {
      return linkModal.type === 'activate'
        ? 'https://archiveofourown.org/users/activate/' + url
        : 'https://archiveofourown.org/signup/' + url;
    }
    return null;
  };

  // 打开链接弹窗; 同时读取剪贴板, 符合 AO3 链接特征就自动填入。
  const openLinkModal = async type => {
    setLinkModal({ visible: true, type });
    setLinkInput('');
    setLinkDetected(false);
    try {
      const text = (await Clipboard.getString()) || '';
      if (isAo3Link(text)) {
        setLinkInput(text.trim());
        setLinkDetected(true);
      }
    } catch (e) {
      // 剪贴板读取失败不阻塞, 用户可手动粘贴
    }
  };

  const closeLinkModal = () => setLinkModal(m => ({ ...m, visible: false }));

  const openPastedLink = async () => {
    const url = normalizeLink(linkInput);
    if (!url) {
      showAlert(t('general_error'), t('screen_account_link_invalid'));
      return;
    }
    closeLinkModal();
    await openOfficial(url);
  };

  const handleLogout = async () => {
    try {
      await deleteCredsToken();
      await deleteCredsPasswd();

      // AO3's session cookie lives in the proxy's in-memory cookie jar, not
      // just in local credentials. Without clearing it, the next login request
      // still carries the old cookie and AO3 responds "already logged in",
      // which makes re-login/account-switch impossible. Restarting the proxy
      // recreates the jar and drops the stale session.
      await clearAuthCookies().catch(e =>
        console.warn('Failed to clear proxy cookies on logout:', e?.message ?? e),
      );

      setIsLoggedIn(false);
    } catch (error) {
      console.error('Logout error:', error);
      showAlert(t('general_error'), t('screen_account_logout_failed'));
    }
  };

  function onBack() {
    navigation.goBack();
  }

  if (validating) {
    return (
      <SafeAreaView
        style={[
          styles.container,
          { backgroundColor: currentTheme.backgroundColor },
        ]}
      >
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={currentTheme.primaryColor} />
        </View>
      </SafeAreaView>
    );
  }

  if (isLoggedIn) {
    return (
      <SafeAreaView
        style={[
          styles.container,
          { backgroundColor: currentTheme.backgroundColor },
        ]}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack}>
            <Icon name="arrow-back" size={24} color={currentTheme.textColor} />
          </TouchableOpacity>
          <Text style={[styles.title_top, { color: currentTheme.textColor }]}>
            Account
          </Text>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContainer}>
          <View style={styles.content}>
            <Text style={[styles.title, { color: currentTheme.textColor }]}>
              Account Status
            </Text>

            <View
              style={[
                styles.statusContainer,
                { backgroundColor: currentTheme.cardBackground },
              ]}
            >
              <Icon name="check-circle" size={48} color="green" />
              <Text
                style={[styles.statusText, { color: currentTheme.textColor }]}
              >
                {t('screen_account_logged_in_title')}
              </Text>
              <Text
                style={[
                  styles.statusSubtext,
                  { color: currentTheme.placeholderColor },
                ]}
              >
                {t('screen_account_logged_in_subtitle')}
              </Text>
            </View>

            <TouchableOpacity
              style={[
                styles.secondaryButton,
                { backgroundColor: currentTheme.cardBackground },
              ]}
              onPress={showSessionInfo}
            >
              <Text
                style={[
                  styles.secondaryButtonText,
                  { color: currentTheme.textColor },
                ]}
              >
                {t('screen_account_check_session_button')}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.logoutButton,
                { backgroundColor: currentTheme.primaryColor },
              ]}
              onPress={handleLogout}
            >
              <Text style={styles.logoutButtonText}>
                {t('screen_account_logout_button')}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        <Modal
          animationType="slide"
          transparent={true}
          visible={sessionInfo.visible}
          onRequestClose={hideSessionInfo}
        >
          <View style={styles.modalContainer}>
            <View
              style={[
                styles.modalContent,
                { backgroundColor: currentTheme.cardBackground },
              ]}
            >
              <Text
                style={[styles.modalTitle, { color: currentTheme.textColor }]}
              >
                {t('screen_account_current_session')}
              </Text>
              <View style={styles.sessionInfoContainer}>
                <Text
                  style={[
                    styles.sessionLabel,
                    { color: currentTheme.placeholderColor },
                  ]}
                >
                  {t('screen_account_current_username')}
                </Text>
                <Text
                  style={[
                    styles.sessionValue,
                    { color: currentTheme.textColor },
                  ]}
                >
                  {sessionInfo.username}
                </Text>
              </View>

              {sessionInfo.hasStoredPassword && (
                <View style={styles.sessionInfoContainer}>
                  <Text
                    style={[
                      styles.sessionLabel,
                      { color: currentTheme.placeholderColor },
                    ]}
                  >
                    {t('screen_account_current_password')}
                  </Text>
                  <Text
                    style={[
                      styles.sessionValue,
                      { color: currentTheme.textColor },
                    ]}
                  >
                    {sessionInfo.password}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[
                  styles.modalButton,
                  { backgroundColor: currentTheme.primaryColor },
                ]}
                onPress={hideSessionInfo}
              >
                <Text style={styles.modalButtonText}>{t('general_close')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        <CustomAlert
          visible={alert.visible}
          title={alert.title}
          message={alert.message}
          onClose={hideAlert}
          theme={currentTheme}
        />
      </SafeAreaView>
    );
  }

  // 未登录：几个按钮，全部打开 AO3 官方页面。注册/激活需要链接,
  // 点击后弹输入框粘贴(自动识别剪贴板)。
  const accountActions = [
    { key: 'screen_account_login', icon: 'login', path: '/users/login', isLogin: true, primary: true },
    { key: 'screen_account_have_invite', icon: 'person-add', linkType: 'signup' },
    { key: 'screen_account_have_activation', icon: 'verified-user', linkType: 'activate' },
    { key: 'screen_account_forgot_password', icon: 'lock-reset', path: '/users/password/new' },
    { key: 'screen_account_get_invited', icon: 'mail', path: '/invite_requests' },
  ];

  return (
    <SafeAreaView
      style={[
        styles.container,
        { backgroundColor: currentTheme.backgroundColor },
      ]}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Icon name="arrow-back" size={24} color={currentTheme.textColor} />
        </TouchableOpacity>
        <Text style={[styles.title_top, { color: currentTheme.textColor }]}>
          {t('screen_account_title')}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContainer}>
        <View style={styles.content}>
          <Text style={[styles.title, { color: currentTheme.textColor }]}>
            {t('screen_account_text')}
          </Text>
          <Text style={[styles.officialHint, { color: currentTheme.placeholderColor }]}>
            {t('screen_account_official_hint')}
          </Text>

          <View style={styles.actionList}>
            {accountActions.map(action => (
              <TouchableOpacity
                key={action.key}
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: action.primary
                      ? currentTheme.primaryColor
                      : currentTheme.cardBackground,
                  },
                ]}
                onPress={() =>
                  action.linkType
                    ? openLinkModal(action.linkType)
                    : openOfficial(action.path, !!action.isLogin)
                }
                disabled={busy}
              >
                <Icon
                  name={action.icon}
                  size={22}
                  color={action.primary ? '#fff' : currentTheme.textColor}
                />
                <Text
                  style={[
                    styles.actionButtonText,
                    {
                      color: action.primary
                        ? '#fff'
                        : currentTheme.textColor,
                    },
                  ]}
                >
                  {action.primary && busy
                    ? t('screen_account_login_loading')
                    : t(action.key)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </ScrollView>

      {/* 邀请/激活链接粘贴弹窗 */}
      <Modal
        visible={linkModal.visible}
        transparent
        animationType="fade"
        onRequestClose={closeLinkModal}
      >
        <View style={styles.linkOverlay}>
          <View
            style={[
              styles.linkBox,
              { backgroundColor: currentTheme.cardBackground },
            ]}
          >
            <Text style={[styles.linkTitle, { color: currentTheme.textColor }]}>
              {t(
                linkModal.type === 'activate'
                  ? 'screen_account_have_activation'
                  : 'screen_account_have_invite',
              )}
            </Text>
            <Text
              style={[
                styles.linkHint,
                { color: currentTheme.placeholderColor },
              ]}
            >
              {t('screen_account_link_paste_hint')}
            </Text>
            {linkDetected && (
              <Text style={styles.linkDetected}>
                {t('screen_account_link_detected')}
              </Text>
            )}
            <TextInput
              style={[
                styles.linkInput,
                {
                  color: currentTheme.textColor,
                  borderColor: currentTheme.borderColor,
                  backgroundColor: currentTheme.inputBackground,
                },
              ]}
              value={linkInput}
              onChangeText={setLinkInput}
              placeholder="https://archiveofourown.org/signup/..."
              placeholderTextColor={currentTheme.placeholderColor}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <TouchableOpacity
              style={[
                styles.linkButton,
                { backgroundColor: currentTheme.primaryColor },
              ]}
              onPress={openPastedLink}
            >
              <Text style={styles.linkButtonText}>
                {t('screen_account_link_open')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.linkCancel}
              onPress={closeLinkModal}
            >
              <Text style={{ color: currentTheme.placeholderColor }}>
                {t('general_cancel')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <CustomAlert
        visible={alert.visible}
        title={alert.title}
        message={alert.message}
        onClose={hideAlert}
        theme={currentTheme}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContainer: {
    flexGrow: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  content: {
    flex: 1,
    padding: 20,
    justifyContent: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 10,
    textAlign: "center",
  },
  officialHint: {
    fontSize: 13,
    textAlign: "center",
    marginBottom: 30,
    lineHeight: 19,
  },
  actionList: {
    width: "100%",
    gap: 12,
  },
  actionButton: {
    borderRadius: 10,
    padding: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    minHeight: 54,
  },
  actionButtonText: {
    fontSize: 17,
    fontWeight: "600",
  },
  linkOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  linkBox: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 12,
    padding: 20,
  },
  linkTitle: {
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 8,
  },
  linkHint: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  linkDetected: {
    fontSize: 13,
    color: "#22c55e",
    marginBottom: 8,
    fontWeight: "600",
  },
  linkInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 70,
    textAlignVertical: "top",
  },
  linkButton: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 12,
  },
  linkButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
  linkCancel: {
    marginTop: 12,
    alignItems: "center",
    paddingVertical: 8,
  },
  statusContainer: {
    padding: 30,
    borderRadius: 12,
    alignItems: "center",
    marginBottom: 20,
  },
  statusText: {
    fontSize: 20,
    fontWeight: "bold",
    marginTop: 15,
  },
  statusSubtext: {
    fontSize: 16,
    marginTop: 5,
  },
  logoutButton: {
    borderRadius: 8,
    padding: 15,
    alignItems: "center",
    marginTop: 10,
  },
  logoutButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "bold",
  },
  secondaryButton: {
    borderRadius: 8,
    padding: 15,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ccc",
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: "bold",
  },
  modalContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  modalContent: {
    width: "80%",
    padding: 20,
    borderRadius: 10,
    alignItems: "center",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 20,
  },
  sessionInfoContainer: {
    width: "100%",
    marginBottom: 20,
  },
  sessionLabel: {
    fontSize: 16,
    fontWeight: "bold",
    marginBottom: 5,
  },
  sessionValue: {
    fontSize: 16,
    padding: 10,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 5,
  },
  modalButton: {
    borderRadius: 8,
    padding: 10,
    alignItems: "center",
    width: "100%",
  },
  modalButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: 20,
    paddingTop: 10,
    paddingBottom: 10,
  },
  title_top: {
    fontSize: 24,
    fontWeight: "bold",
    marginLeft: 16,
  },
});

export default LoginScreen;
