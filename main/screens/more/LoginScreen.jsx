import React, { useContext, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import login, { resolveAuthenticatedUsername, validateCookie } from '../../web/account/login';
import AccountSetupModal from '../../components/Account/AccountSetupModal';
import {
  deleteCredsPasswd,
  deleteCredsToken,
  getCredsPasswd,
  getCredsToken,
  getUsername,
  setCredsPasswd,
  setCredsToken,
  setLastLogin,
  setUsernameOnly,
} from '../../storage/Credentials';
import CustomAlert from '../../components/CustomAlert';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppContext } from '../../app';

const LoginScreen = ({ route }) => {
  const { currentTheme } = useContext(AppContext);
  const navigation = useNavigation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [validating, setValidating] = useState(true);
  // In-app account flows (password reset / invitation + registration).
  const [setupModal, setSetupModal] = useState({ visible: false, mode: 'password' });

  const [alert, setAlert] = useState({
    visible: false,
    title: '',
    message: '',
  });
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

  const handleLogin = async () => {
    if (!username || !password) {
      showAlert(t('general_error'), t('screen_account_credentials_required'));
      return;
    }

    setIsLoading(true);
    try {
      const sessionToken = await login(username, password);

      if (sessionToken) {
        await setCredsToken(sessionToken);
        // AO3 accepts an email for login, but user/bookmark URLs use the
        // canonical AO3 username. Keep the login identifier for credentials,
        // and store the resolved username separately for account routes.
        if (rememberPassword) {
          await setCredsPasswd(username, password);
        } else {
          // This also clears the legacy username_only key. Re-create the
          // identity after clearing credentials, otherwise the session modal
          // and bookmark routes see an empty username.
          await deleteCredsPasswd();
        }

        const canonicalUsername = await resolveAuthenticatedUsername(sessionToken);
        const accountUsername = canonicalUsername || username;
        // Always persist this separately: remembered credentials retain the
        // email/login identifier, while bookmarks use this canonical value.
        await setUsernameOnly(accountUsername);

        setIsLoggedIn(true);
        await setLastLogin();
        showAlert(t('general_success'), t('screen_account_login_success'));
      } else {
        showAlert(
          t('screen_account_login_failed'),
          t('screen_account_login_failed_invalid_creds_or_server_error'),
        );
      }
    } catch (error) {
      console.error('Login error:', error);
      showAlert(
        t('screen_account_login_failed'),
        t('screen_account_login_failed_generic'),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await deleteCredsToken();
      await deleteCredsPasswd();

      setIsLoggedIn(false);
      setUsername('');
      setPassword('');
      setRememberPassword(false);
    } catch (error) {
      console.error('Logout error:', error);
      showAlert(t('general_error'), t('screen_account_logout_failed'));
    }
  };

  const showRememberPasswordInfo = () => {
    showAlert(
      t('screen_account_remember_password_modal_title'),
      t('screen_account_remember_password_modal_text'),
    );
  };

  // Both flows are handled in-app by AccountSetupModal: it fetches AO3's own
  // forms and posts them back through the ECH proxy. Opening a browser would
  // fail entirely on networks where AO3 is blocked.
  const openForgotPassword = () => setSetupModal({ visible: true, mode: 'password' });
  const openGetInvited = () => setSetupModal({ visible: true, mode: 'invite' });

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

  function onBack() {
    navigation.goBack();
  }

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

          <View style={styles.formContainer}>
            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: currentTheme.textColor }]}>
                {t('screen_account_username')}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: currentTheme.inputBackground,
                    borderColor: currentTheme.borderColor,
                    color: currentTheme.textColor,
                  },
                ]}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="username"
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: currentTheme.textColor }]}>
                {t('screen_account_password')}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: currentTheme.inputBackground,
                    borderColor: currentTheme.borderColor,
                    color: currentTheme.textColor,
                  },
                ]}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                textContentType="password"
              />
            </View>

            <View style={styles.rememberContainer}>
              <TouchableOpacity
                style={styles.rememberButton}
                onPress={() => setRememberPassword(!rememberPassword)}
              >
                <Icon
                  name={
                    rememberPassword ? 'check-box' : 'check-box-outline-blank'
                  }
                  size={24}
                  color={currentTheme.primaryColor}
                />
                <Text
                  style={[
                    styles.rememberText,
                    { color: currentTheme.textColor },
                  ]}
                >
                  {t('screen_account_remember_password')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={showRememberPasswordInfo}
                style={styles.infoButton}
              >
                <Icon
                  name="info-outline"
                  size={20}
                  color={currentTheme.placeholderColor}
                />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[
                styles.loginButton,
                { backgroundColor: currentTheme.primaryColor },
              ]}
              onPress={handleLogin}
              disabled={isLoading}
            >
              <Text style={styles.loginButtonText}>
                {isLoading
                  ? t('screen_account_login_loading')
                  : t('screen_account_login')}
              </Text>
            </TouchableOpacity>

            <View style={styles.footerButtons}>
              <TouchableOpacity
                onPress={openForgotPassword}
                style={styles.footerButton}
              >
                <Text
                  style={[
                    styles.footerButtonText,
                    { color: currentTheme.primaryColor },
                  ]}
                >
                  {t('screen_account_forgot_password')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={openGetInvited}
                style={styles.footerButton}
              >
                <Text
                  style={[
                    styles.footerButtonText,
                    { color: currentTheme.primaryColor },
                  ]}
                >
                  {t('screen_account_get_invited')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </ScrollView>

      <AccountSetupModal
        visible={setupModal.visible}
        mode={setupModal.mode}
        theme={currentTheme}
        onClose={() => setSetupModal(m => ({ ...m, visible: false }))}
      />

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
    marginBottom: 30,
    textAlign: "center",
  },
  header_title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginLeft: 16,
  },
  formContainer: {
    width: "100%",
  },
  inputGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 16,
    marginBottom: 8,
    fontWeight: "500",
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  rememberContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 25,
  },
  rememberButton: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  rememberText: {
    fontSize: 16,
    marginLeft: 8,
  },
  infoButton: {
    padding: 5,
  },
  loginButton: {
    borderRadius: 8,
    padding: 15,
    alignItems: "center",
    marginBottom: 20,
  },
  loginButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "bold",
  },
  footerButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerButton: {
    padding: 10,
  },
  footerButtonText: {
    fontSize: 16,
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
  requestOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  requestBox: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 12,
    padding: 20,
  },
  requestTitle: { fontSize: 17, fontWeight: '600' },
  requestLabel: { fontSize: 13, marginTop: 8 },
  requestInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
    fontSize: 15,
  },
  requestActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
    marginTop: 16,
  },
  requestAction: { paddingVertical: 8, paddingHorizontal: 8 },
});

export default LoginScreen;
