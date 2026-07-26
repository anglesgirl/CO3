import React, { useState } from 'react';
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
import { useTranslation } from 'react-i18next';
import {
  activateAccount,
  extractInvitationToken,
  registerAccount,
  requestInvitation,
  requestPasswordReset,
} from '../../web/account/accountRequests';

/**
 * Guides the user through AO3's whole account journey without ever leaving the
 * app: request an invitation, paste the emailed invitation link, fill in the
 * sign-up form, then paste the activation link. Every request goes through the
 * ECH proxy, so it also works where AO3 is blocked.
 *
 * mode:
 *   'password' — password reset only (single step)
 *   'invite'   — the full invite -> register -> activate flow
 */
export default function AccountSetupModal({ visible, mode, theme, onClose }) {
  const { t } = useTranslation();

  // Steps for the invite flow: request -> paste -> form -> activate
  const [step, setStep] = useState('request');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { ok, text }

  const [email, setEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [activationLink, setActivationLink] = useState('');

  const reset = () => {
    setStep('request');
    setNotice(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    onClose?.();
  };

  const run = async (fn, onSuccess) => {
    setBusy(true);
    setNotice(null);
    try {
      const msg = await fn();
      setNotice({ ok: true, text: msg });
      onSuccess?.(msg);
    } catch (e) {
      setNotice({ ok: false, text: e?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  };

  const input = (value, setter, placeholder, extra = {}) => (
    <TextInput
      style={[
        styles.input,
        {
          color: theme.textColor,
          borderColor: theme.borderColor,
          backgroundColor: theme.inputBackground,
        },
      ]}
      value={value}
      onChangeText={setter}
      placeholder={placeholder}
      placeholderTextColor={theme.secondaryTextColor}
      autoCapitalize="none"
      autoCorrect={false}
      editable={!busy}
      {...extra}
    />
  );

  const primary = (label, onPress) => (
    <TouchableOpacity
      style={[styles.primaryButton, { backgroundColor: theme.primaryColor }]}
      onPress={onPress}
      disabled={busy}
    >
      {busy ? (
        <ActivityIndicator size="small" color="#fff" />
      ) : (
        <Text style={styles.primaryButtonText}>{label}</Text>
      )}
    </TouchableOpacity>
  );

  const stepLabel = (n, label, active) => (
    <Text
      style={{
        fontSize: 12,
        color: active ? theme.primaryColor : theme.secondaryTextColor,
        fontWeight: active ? '700' : '400',
      }}
    >
      {n}. {label}
    </Text>
  );

  const renderPasswordFlow = () => (
    <>
      <Text style={[styles.body, { color: theme.secondaryTextColor }]}>
        {t('account_request_login_label')}
      </Text>
      {input(email, setEmail, t('screen_account_username'))}
      {primary(t('account_request_submit'), () =>
        run(() => requestPasswordReset(email)),
      )}
      <Text style={[styles.hint, { color: theme.secondaryTextColor }]}>
        {t('account_reset_hint')}
      </Text>
      <View style={[styles.tipBox, { borderColor: theme.primaryColor }]}>
        <Text style={[styles.tipText, { color: theme.textColor }]}>
          {t('account_copy_link_tip')}
        </Text>
      </View>
    </>
  );

  const renderInviteFlow = () => (
    <>
      <View style={styles.steps}>
        {stepLabel(1, t('account_step_request'), step === 'request')}
        {stepLabel(2, t('account_step_paste'), step === 'paste')}
        {stepLabel(3, t('account_step_register'), step === 'form')}
        {stepLabel(4, t('account_step_activate'), step === 'activate')}
      </View>

      {step === 'request' && (
        <>
          <Text style={[styles.body, { color: theme.secondaryTextColor }]}>
            {t('account_invite_intro')}
          </Text>
          {input(email, setEmail, 'you@example.com', {
            keyboardType: 'email-address',
          })}
          {primary(t('account_request_submit'), () =>
            run(
              () => requestInvitation(email),
              () => setStep('paste'),
            ),
          )}
          <TouchableOpacity onPress={() => setStep('paste')}>
            <Text style={[styles.link, { color: theme.primaryColor }]}>
              {t('account_have_invite_already')}
            </Text>
          </TouchableOpacity>
        </>
      )}

      {step === 'paste' && (
        <>
          <Text style={[styles.body, { color: theme.secondaryTextColor }]}>
            {t('account_paste_invite_hint')}
          </Text>
          <View style={[styles.tipBox, { borderColor: theme.primaryColor }]}>
            <Text style={[styles.tipText, { color: theme.textColor }]}>
              {t('account_copy_link_tip')}
            </Text>
          </View>
          {input(
            inviteLink,
            setInviteLink,
            'https://archiveofourown.org/signup/...',
          )}
          {primary(t('general_ok'), () =>
            run(
              async () => {
                const tk = extractInvitationToken(inviteLink);
                setToken(tk);
                return t('account_invite_link_ok');
              },
              () => setStep('form'),
            ),
          )}
        </>
      )}

      {step === 'form' && (
        <>
          <Text style={[styles.body, { color: theme.secondaryTextColor }]}>
            {t('account_register_hint')}
          </Text>
          {input(username, setUsername, t('screen_account_username'))}
          {input(regEmail, setRegEmail, 'you@example.com', {
            keyboardType: 'email-address',
          })}
          {input(password, setPassword, t('screen_account_password'), {
            secureTextEntry: true,
          })}
          {input(
            passwordConfirm,
            setPasswordConfirm,
            t('account_password_confirm'),
            { secureTextEntry: true },
          )}
          <Text style={[styles.hint, { color: theme.secondaryTextColor }]}>
            {t('account_tos_notice')}
          </Text>
          {primary(t('account_create_account'), () =>
            run(
              () =>
                registerAccount({
                  token,
                  username,
                  email: regEmail,
                  password,
                  passwordConfirm,
                }),
              () => setStep('activate'),
            ),
          )}
        </>
      )}

      {step === 'activate' && (
        <>
          <Text style={[styles.body, { color: theme.secondaryTextColor }]}>
            {t('account_activate_hint')}
          </Text>
          <View style={[styles.tipBox, { borderColor: theme.primaryColor }]}>
            <Text style={[styles.tipText, { color: theme.textColor }]}>
              {t('account_copy_link_tip')}
            </Text>
          </View>
          {input(
            activationLink,
            setActivationLink,
            'https://archiveofourown.org/users/activate/...',
          )}
          {primary(t('account_activate_button'), () =>
            run(() => activateAccount(activationLink)),
          )}
        </>
      )}
    </>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={[styles.box, { backgroundColor: theme.cardBackground }]}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={[styles.title, { color: theme.textColor }]}>
              {mode === 'password'
                ? t('screen_account_forgot_password')
                : t('screen_account_get_invited')}
            </Text>

            {mode === 'password' ? renderPasswordFlow() : renderInviteFlow()}

            {notice && (
              <View
                style={[
                  styles.notice,
                  { borderColor: notice.ok ? '#22c55e' : '#ef4444' },
                ]}
              >
                <Text style={{ color: notice.ok ? '#22c55e' : '#ef4444', fontSize: 13 }}>
                  {notice.text}
                </Text>
              </View>
            )}

            <TouchableOpacity style={styles.closeButton} onPress={close}>
              <Text style={{ color: theme.secondaryTextColor }}>
                {t('general_cancel')}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  box: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
    borderRadius: 12,
    padding: 20,
  },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 10 },
  steps: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 12,
  },
  body: { fontSize: 13, lineHeight: 19, marginBottom: 10 },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  link: { fontSize: 13, marginTop: 12, textAlign: 'center' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
    fontSize: 15,
  },
  primaryButton: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  primaryButtonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  tipBox: {
    marginTop: 10,
    padding: 10,
    borderWidth: 1,
    borderRadius: 8,
    borderStyle: 'dashed',
  },
  tipText: { fontSize: 12, lineHeight: 18 },
  notice: { marginTop: 14, padding: 10, borderWidth: 1, borderRadius: 8 },
  closeButton: { marginTop: 16, alignItems: 'center', paddingVertical: 8 },
});
