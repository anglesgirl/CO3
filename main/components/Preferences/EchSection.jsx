import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import {
  echSelfTest,
  getDoh,
  setDoh,
  getCustomIPs,
  setCustomIPs,
  getConfigDomain,
  setConfigDomain,
  fetchRemoteConfig,
  syncRemoteConfig,
  clearManualOverride,
  DEFAULT_DOH,
} from '../../web/echKy';

/**
 * Network & Connection (ECH) settings.
 *
 * Ordinary users only need the single "check connection" button — everything
 * else is normally configured automatically from the remote TXT record. The
 * technical knobs live behind a collapsed "Advanced" disclosure.
 */
export default function EchSection({ theme }) {
  const { t } = useTranslation();

  const [doh, setDohInput] = useState('');
  const [ips, setIpsInput] = useState('');
  const [cfgDomain, setCfgDomainInput] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null); // { ok, title, detail }

  useEffect(() => {
    getDoh().then(setDohInput);
    getCustomIPs().then(setIpsInput);
    getConfigDomain().then(setCfgDomainInput);
  }, []);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const raw = await echSelfTest();
      const echOk = raw.includes('ECHAccepted=true');
      const httpOk = raw.startsWith('OK');
      setResult({
        ok: echOk,
        title: echOk
          ? t('ech_status_ok')
          : httpOk
            ? t('ech_status_ok_no_ech')
            : t('ech_status_failed'),
        detail: raw,
      });
    } catch (e) {
      setResult({ ok: false, title: t('ech_status_failed'), detail: String(e?.message ?? e) });
    } finally {
      setTesting(false);
    }
  };

  const flash = (ok, msg) => setResult({ ok, title: msg, detail: '' });

  const btn = (label, onPress, color) => (
    <TouchableOpacity
      style={[styles.button, { backgroundColor: color || theme.iconColor || '#2563eb' }]}
      onPress={onPress}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.section, { borderBottomColor: theme.borderColor }]}>
      <View style={styles.sectionHeader}>
        <Icon name="vpn-lock" size={20} color={theme.iconColor} />
        <Text style={[{ color: theme.textColor }, styles.sectionTitle]}>
          {t('ech_title')}
        </Text>
      </View>

      <Text style={[styles.desc, { color: theme.textColor }]}>{t('ech_desc')}</Text>

      {btn(testing ? t('ech_status_testing') : t('ech_status_button'), runTest)}

      {result && (
        <View
          style={[
            styles.resultBox,
            { borderColor: result.ok ? '#22c55e' : '#ef4444' },
          ]}
        >
          <Text style={{ color: result.ok ? '#22c55e' : '#ef4444', fontWeight: '600' }}>
            {result.title}
          </Text>
          {!!result.detail && (
            <Text style={[styles.detail, { color: theme.textColor }]}>{result.detail}</Text>
          )}
        </View>
      )}

      {/* Advanced disclosure */}
      <TouchableOpacity
        style={styles.advancedToggle}
        onPress={() => setAdvanced(v => !v)}
      >
        <Icon
          name={advanced ? 'expand-less' : 'expand-more'}
          size={20}
          color={theme.iconColor}
        />
        <Text style={{ color: theme.textColor }}>{t('ech_advanced')}</Text>
      </TouchableOpacity>

      {advanced && (
        <View>
          {/* Remote config domain */}
          <Text style={[styles.label, { color: theme.textColor }]}>
            {t('ech_config_domain')}
          </Text>
          <Text style={[styles.hint, { color: theme.textColor }]}>
            {t('ech_config_domain_desc')}
          </Text>
          <TextInput
            style={[styles.input, { color: theme.textColor, borderColor: theme.borderColor }]}
            autoCapitalize="none"
            autoCorrect={false}
            value={cfgDomain}
            onChangeText={setCfgDomainInput}
          />
          <View style={styles.row}>
            {btn(t('ech_get_remote_doh'), async () => {
              try {
                await setConfigDomain(cfgDomain);
                const cfg = await fetchRemoteConfig(cfgDomain);
                if (!cfg.doh) return flash(false, t('ech_fetch_failed'));
                setDohInput(cfg.doh);
                await setDoh(cfg.doh, false);
                flash(true, t('ech_applied'));
              } catch (e) {
                flash(false, `${t('ech_fetch_failed')}: ${e?.message ?? e}`);
              }
            })}
            {btn(t('ech_get_remote_ip'), async () => {
              try {
                await setConfigDomain(cfgDomain);
                const cfg = await fetchRemoteConfig(cfgDomain);
                if (!cfg.ip) return flash(false, t('ech_fetch_failed'));
                setIpsInput(cfg.ip);
                await setCustomIPs(cfg.ip, false);
                flash(true, t('ech_applied'));
              } catch (e) {
                flash(false, `${t('ech_fetch_failed')}: ${e?.message ?? e}`);
              }
            })}
            {btn(
              t('ech_reenable_auto'),
              async () => {
                try {
                  await clearManualOverride();
                  await syncRemoteConfig();
                  setDohInput(await getDoh());
                  setIpsInput(await getCustomIPs());
                  flash(true, t('ech_auto_restored'));
                } catch (e) {
                  flash(false, `${t('ech_fetch_failed')}: ${e?.message ?? e}`);
                }
              },
              '#6b7280',
            )}
          </View>

          {/* DoH */}
          <Text style={[styles.label, { color: theme.textColor }]}>
            {t('ech_doh_label')}
          </Text>
          <Text style={[styles.hint, { color: theme.textColor }]}>
            {t('ech_doh_desc')}
          </Text>
          <TextInput
            style={[styles.input, { color: theme.textColor, borderColor: theme.borderColor }]}
            autoCapitalize="none"
            autoCorrect={false}
            value={doh}
            onChangeText={setDohInput}
          />
          <View style={styles.row}>
            {btn(t('ech_save_restart'), async () => {
              try {
                await setDoh(doh);
                flash(true, t('ech_applied'));
              } catch (e) {
                flash(false, String(e?.message ?? e));
              }
            })}
            {btn(t('ech_reset_default'), () => setDohInput(DEFAULT_DOH), '#6b7280')}
          </View>

          {/* Preferred IPs */}
          <Text style={[styles.label, { color: theme.textColor }]}>
            {t('ech_ip_label')}
          </Text>
          <Text style={[styles.hint, { color: theme.textColor }]}>
            {t('ech_ip_desc')}
          </Text>
          <TextInput
            style={[styles.input, { color: theme.textColor, borderColor: theme.borderColor }]}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="104.20.8.2, 104.20.9.2"
            placeholderTextColor="#888"
            value={ips}
            onChangeText={setIpsInput}
          />
          <View style={styles.row}>
            {btn(t('ech_save_restart'), async () => {
              try {
                await setCustomIPs(ips);
                flash(true, t('ech_applied'));
              } catch (e) {
                flash(false, String(e?.message ?? e));
              }
            })}
            {btn(t('ech_clear'), () => setIpsInput(''), '#6b7280')}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingVertical: 16, paddingHorizontal: 16, borderBottomWidth: 1 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '600' },
  desc: { fontSize: 13, opacity: 0.7, marginBottom: 12 },
  button: {
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  resultBox: { marginTop: 12, padding: 10, borderWidth: 1, borderRadius: 8 },
  detail: { fontSize: 11, opacity: 0.7, marginTop: 6 },
  advancedToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 16 },
  label: { fontSize: 14, fontWeight: '600', marginTop: 16 },
  hint: { fontSize: 12, opacity: 0.6, marginTop: 2 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 6,
    fontSize: 13,
  },
});
