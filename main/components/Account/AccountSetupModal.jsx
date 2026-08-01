import React, { useEffect, useState } from 'react';
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
import { userErrorMessage } from '../../utils/userError';
import {
  activateAccount,
  extractInvitationToken,
  getInvitationQueueInfo,
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
  const [queueInfo, setQueueInfo] = useState(null);
  const [lookupEmail, setLookupEmail] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [activationLink, setActivationLink] = useState('');

  useEffect(() => {
    if (!visible || mode !== 'invite') return undefined;
    let active = true;
    getInvitationQueueInfo()
      .then(info => active && setQueueInfo(info))
      .catch(error => {
        if (!active) return;
        setNotice({
          ok: false,
          missing: error?.code === 'INVITE_PAGE_NOT_FOUND',
          text: userErrorMessage(error, t),
        });
      });
    return () => { active = false; };
  }, [visible, mode]);

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
      const result = await fn();
      const text = typeof result === 'string' ? result : result.message;
      setNotice({ ok: true, text });
      onSuccess?.(result);
    } catch (e) {
      setNotice({
        ok: false,
        missing: e?.code === 'INVITE_PAGE_NOT_FOUND',
        text: userErrorMessage(e, t),
      });
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

  const renderQueueInfo = () => {
    if (!queueInfo) return null;
    let estimated = queueInfo.estimatedDate;
    if (estimated && /^\d{4}-\d{2}-\d{2}T/.test(estimated)) {
      estimated = new Date(estimated).toLocaleDateString();
    }
    return (
      <View style={[styles.queueBox, { borderColor: theme.borderColor }]}>
        {queueInfo.waiting !== null && (
          <Text style={[styles.queueText, { color: theme.textColor }]}>
            {t('account_queue_waiting', { count: queueInfo.waiting.toLocaleString() })}
          </Text>
        )}
        {queueInfo.batchSize !== null && (
          <Text style={[styles.queueText, { color: theme.secondaryTextColor }]}>
            {t('account_queue_rate', {
              count: queueInfo.batchSize.toLocaleString(),
              hours: queueInfo.intervalHours,
            })}
          </Text>
        )}
        {queueInfo.position !== null && (
          <Text style={[styles.queuePosition, { color: theme.primaryColor }]}>
            {t('account_queue_position', { position: queueInfo.position.toLocaleString() })}
          </Text>
        )}
        {estimated && (
          <Text style={[styles.queueText, { color: theme.textColor }]}>
            {t('account_queue_estimated', { date: estimated })}
          </Text>
        )}
      </View>
    );
  };

  const lookupQueuePosition = async () => {
    if (!lookupEmail.trim()) {
      setNotice({ ok: false, text: t('account_queue_email_required') });
      return;
    }
    setLookupBusy(true);
    setNotice(null);
    try {
      const info = await getInvitationQueueInfo(lookupEmail);
      setQueueInfo(info);
      setNotice({
        ok: info.position !== null,
        text: info.position !== null
          ? t('account_queue_lookup_success')
          : t('account_queue_email_not_found'),
      });
    } catch (error) {
      setNotice({
        ok: false,
        missing: error?.code === 'INVITE_PAGE_NOT_FOUND',
        text: userErrorMessage(error, t),
      });
    } finally {
      setLookupBusy(false);
    }
  };

  const renderQueueLookup = () => (
    <View style={styles.lookupSection}>
      <Text style={[styles.hint, { color: theme.secondaryTextColor }]}>
        {t('account_queue_lookup_hint')}
      </Text>
      {input(lookupEmail, setLookupEmail, 'you@example.com', {
        keyboardType: 'email-address',
        editable: !lookupBusy && !busy,
      })}
      <TouchableOpacity
        style={[styles.lookupButton, { borderColor: theme.primaryColor }]}
        onPress={lookupQueuePosition}
        disabled={lookupBusy || busy}
      >
        {lookupBusy ? (
          <ActivityIndicator size="small" color={theme.primaryColor} />
        ) : (
          <Text style={[styles.lookupButtonText, { color: theme.primaryColor }]}>
            {t('account_queue_lookup')}
          </Text>
        )}
      </TouchableOpacity>
    </View>
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

      {renderQueueInfo()}
      {step === 'request' && renderQueueLookup()}

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
              result => {
                setQueueInfo(result.queue);
                setStep('paste');
              },
            ),
          )}
          <TouchableOpacity onPress={() => setStep('paste')}>
            <Text style={[styles.link, { color: theme.primaryColor }]}>
              {t('account_have_invite_already')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setStep('activate')}>
            <Text style={[styles.link, { color: theme.primaryColor }]}>
              {t('account_have_activation_already')}
            </Text>
          </TouchableOpacity>
        </>
      )}

      {step === 'paste' && (
        <>
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
                {notice.missing && (
                  <Text style={[styles.noticeTitle, { color: '#ef4444' }]}>
                    {t('account_invite_unavailable_title')}
                  </Text>
                )}
                <Text style={{ color: notice.ok ? '#22c55e' : '#ef4444', fontSize: 13 }}>
                  {notice.missing ? t('account_invite_unavailable_body') : notice.text}
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
  noticeTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  queueBox: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12 },
  queueText: { fontSize: 12, lineHeight: 18 },
  queuePosition: { fontSize: 15, fontWeight: '700', marginTop: 4 },
  lookupSection: { marginBottom: 12 },
  lookupButton: {
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  lookupButtonText: { fontSize: 14, fontWeight: '600' },
  closeButton: { marginTop: 16, alignItems: 'center', paddingVertical: 8 },
});
