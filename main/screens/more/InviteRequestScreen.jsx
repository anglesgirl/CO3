import React, { useContext, useEffect, useState } from 'react';
import {
  ActivityIndicator, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { AppContext } from '../../app';
import {
  estimateInvitationDate, fetchInviteInfo, fetchInviteStatus, requestInvitation,
} from '../../web/account/inviteRequests';

const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

function useInviteState() {
  const [info, setInfo] = useState(null);
  const [email, setEmail] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const loadInfo = async () => {
    setLoading(true);
    setError(null);
    try {
      setInfo(await fetchInviteInfo());
    } catch (requestError) {
      const status = requestError?.response?.status || requestError?.status;
      setError(status === 404 ? 'notFound' : 'network');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadInfo(); }, []);
  const runAction = async action => {
    setSubmitting(true); setError(null); setResult(null);
    try {
      setResult(await action());
    } catch (requestError) {
      const status = requestError?.response?.status || requestError?.status;
      setError(status === 404 ? 'notFound' : 'submit');
    } finally {
      setSubmitting(false);
    }
  };

  return {
    info, email, setEmail, accepted, setAccepted, loading, submitting,
    error, setError, result, loadInfo, runAction,
  };
}

function useInviteActions(model) {
  const validate = () => {
    if (validEmail(model.email)) return true;
    model.setError('email');
    return false;
  };
  const submit = async () => {
    if (validate() && model.accepted) {
      await model.runAction(() => requestInvitation(model.email.trim()));
    }
  };
  const check = async () => {
    if (!validate()) return;
    await model.runAction(async () => {
      const status = await fetchInviteStatus(model.email.trim());
      if (!status.found) return { notFound: true };
      const schedule = {
        batchSize: model.info?.invitationsPerBatch,
        batchHours: model.info?.batchHours,
      };
      return {
        position: status.position,
        estimatedAt: estimateInvitationDate(status.position, schedule),
      };
    });
  };
  return { submit, check };
}

const Header = ({ theme, title, onBack }) => (
  <View style={[styles.header, { borderBottomColor: theme.borderColor }]}>
    <TouchableOpacity onPress={onBack}>
      <Icon name="arrow-back" size={24} color={theme.textColor} />
    </TouchableOpacity>
    <Text style={[styles.headerTitle, { color: theme.textColor }]}>{title}</Text>
  </View>
);

function ErrorMessage({ type, t }) {
  if (!type) return null;
  const keys = {
    email: 'screen_invite_invalid_email',
    notFound: 'screen_invite_404',
    network: 'screen_invite_network_error',
    submit: 'screen_invite_submit_error',
  };
  return <Text style={styles.errorText}>{t(keys[type])}</Text>;
}

function ErrorScreen({ model, theme, navigation, t }) {
  const unavailable = model.error === 'notFound';
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
      <Header theme={theme} title={t('screen_invite_title')} onBack={() => navigation.goBack()} />
      <View style={styles.center}>
        <Icon name={unavailable ? 'link-off' : 'cloud-off'} size={54} color={theme.iconColor} />
        <Text style={[styles.errorTitle, { color: theme.textColor }]}>
          {t(unavailable ? 'screen_invite_404_title' : 'screen_invite_network_title')}
        </Text>
        <ErrorMessage type={model.error} t={t} />
        <TouchableOpacity style={[styles.retryButton, { backgroundColor: theme.primaryColor }]} onPress={model.loadInfo}>
          <Icon name="refresh" size={20} color="white" />
          <Text style={styles.buttonText}>{t('general_retry')}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function QueueSummary({ info, theme, t }) {
  return (
    <View style={[styles.queueBand, { borderColor: theme.borderColor }]}>
      <Text style={[styles.queueCount, { color: theme.primaryColor }]}>
        {info?.queueCount?.toLocaleString() || t('general_unknown')}
      </Text>
      <Text style={[styles.queueLabel, { color: theme.textColor }]}>{t('screen_invite_waiting')}</Text>
      <Text style={[styles.rate, { color: theme.placeholderColor }]}>
        {t('screen_invite_rate', {
          count: info?.invitationsPerBatch?.toLocaleString() || '?',
          hours: info?.batchHours || '?',
        })}
      </Text>
    </View>
  );
}

function ResultPanel({ result, theme, t }) {
  if (result?.notFound) return <Text style={styles.errorText}>{t('screen_invite_email_not_found')}</Text>;
  if (!result?.position) return null;
  const estimate = result.estimatedAt
    ? t('screen_invite_estimate', { date: result.estimatedAt.toLocaleString() })
    : t('screen_invite_estimate_unknown');
  return (
    <View style={[styles.result, { borderColor: theme.primaryColor }]}>
      <Icon name="schedule" size={28} color={theme.primaryColor} />
      <Text selectable style={[styles.resultTitle, { color: theme.textColor }]}>
        {t('screen_invite_position', { position: result.position.toLocaleString() })}
      </Text>
      <Text selectable style={[styles.resultText, { color: theme.placeholderColor }]}>{estimate}</Text>
    </View>
  );
}

function InviteActions({ model, actions, theme, t }) {
  return (
    <>
      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: theme.primaryColor }, (!model.accepted || model.submitting) && styles.disabled]}
        onPress={actions.submit}
        disabled={!model.accepted || model.submitting}
      >
        {model.submitting
          ? <ActivityIndicator color="white" />
          : <Icon name="mail-outline" size={20} color="white" />}
        <Text style={styles.buttonText}>{t('screen_invite_submit')}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.checkButton, { borderColor: theme.primaryColor }]} onPress={actions.check} disabled={model.submitting}>
        <Icon name="manage-search" size={20} color={theme.primaryColor} />
        <Text style={[styles.checkText, { color: theme.primaryColor }]}>{t('screen_invite_check')}</Text>
      </TouchableOpacity>
    </>
  );
}

function InviteForm({ model, actions, theme, t }) {
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <QueueSummary info={model.info} theme={theme} t={t} />
      <Text style={[styles.label, { color: theme.textColor }]}>{t('screen_invite_email')}</Text>
      <TextInput
        style={[styles.input, { color: theme.textColor, borderColor: theme.borderColor, backgroundColor: theme.inputBackground }]}
        value={model.email} onChangeText={model.setEmail} keyboardType="email-address"
        autoCapitalize="none" autoCorrect={false}
      />
      <TouchableOpacity style={styles.consent} onPress={() => model.setAccepted(value => !value)}>
        <Icon name={model.accepted ? 'check-box' : 'check-box-outline-blank'} size={24} color={theme.primaryColor} />
        <Text style={[styles.consentText, { color: theme.textColor }]}>{t('screen_invite_consent')}</Text>
      </TouchableOpacity>
      <ErrorMessage type={model.error} t={t} />
      <ResultPanel result={model.result} theme={theme} t={t} />
      <InviteActions model={model} actions={actions} theme={theme} t={t} />
    </ScrollView>
  );
}

const InviteRequestScreen = ({ navigation }) => {
  const { currentTheme } = useContext(AppContext);
  const { t } = useTranslation();
  const model = useInviteState();
  const actions = useInviteActions(model);
  if (model.loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: currentTheme.backgroundColor }]}>
        <ActivityIndicator style={styles.loader} size="large" color={currentTheme.primaryColor} />
      </SafeAreaView>
    );
  }
  if (model.error === 'notFound' || model.error === 'network') {
    return <ErrorScreen model={model} theme={currentTheme} navigation={navigation} t={t} />;
  }
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: currentTheme.backgroundColor }]}>
      <Header theme={currentTheme} title={t('screen_invite_title')} onBack={() => navigation.goBack()} />
      <InviteForm model={model} actions={actions} theme={currentTheme} t={t} />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 }, loader: { flex: 1 },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 16, borderBottomWidth: 1 },
  headerTitle: { fontSize: 20, fontWeight: '600' }, content: { padding: 20, gap: 14 },
  queueBand: { alignItems: 'center', paddingVertical: 20, borderTopWidth: 1, borderBottomWidth: 1 },
  queueCount: { fontSize: 34, fontWeight: '700' }, queueLabel: { fontSize: 16, marginTop: 2 },
  rate: { fontSize: 13, marginTop: 8 }, label: { fontSize: 15, fontWeight: '600', marginTop: 6 },
  input: { height: 48, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, fontSize: 16 },
  consent: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  consentText: { flex: 1, fontSize: 13, lineHeight: 19 }, errorText: { color: '#dc2626', textAlign: 'center', lineHeight: 20 },
  result: { alignItems: 'center', gap: 7, borderWidth: 1, borderRadius: 6, padding: 16 },
  resultTitle: { fontSize: 18, fontWeight: '600', textAlign: 'center' }, resultText: { fontSize: 14, textAlign: 'center' },
  primaryButton: { height: 48, borderRadius: 6, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  checkButton: { height: 48, borderRadius: 6, borderWidth: 1, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: 'white', fontSize: 15, fontWeight: '600' }, checkText: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 },
  errorTitle: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  retryButton: { height: 44, paddingHorizontal: 18, borderRadius: 6, flexDirection: 'row', gap: 8, alignItems: 'center' },
});

export default InviteRequestScreen;
