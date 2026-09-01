import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { echSelfTest } from '../../web/echKy';

// 最纯粹的 ECH：只做通网，只留状态显示，无高级配置
export default function EchSection({ theme }) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const raw = await echSelfTest();
      const echOk = raw.includes('ECHAccepted=true');
      const httpOk = raw.startsWith('OK');
      setResult({
        ok: echOk,
        title: echOk ? t('ech_status_ok') : httpOk ? t('ech_status_ok_no_ech') : t('ech_status_failed'),
        detail: raw,
      });
    } catch (e) {
      setResult({ ok: false, title: t('ech_status_failed'), detail: String(e?.message ?? e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <View style={[styles.section, { borderBottomColor: theme.borderColor }]}>
      <View style={styles.sectionHeader}>
        <Icon name="vpn-lock" size={20} color={theme.iconColor} />
        <Text style={[{ color: theme.textColor }, styles.sectionTitle]}>{t('ech_title')}</Text>
      </View>
      <Text style={[styles.desc, { color: theme.textColor }]}>{t('ech_desc')}</Text>

      <TouchableOpacity
        style={[styles.button, { backgroundColor: theme.iconColor || '#2563eb' }]}
        onPress={runTest}
        disabled={testing}
      >
        <Text style={styles.buttonText}>{testing ? t('ech_status_testing') : t('ech_status_button')}</Text>
      </TouchableOpacity>

      {result && (
        <View style={[styles.resultBox, { borderColor: result.ok ? '#22c55e' : '#ef4444' }]}>
          <Text style={{ color: result.ok ? '#22c55e' : '#ef4444', fontWeight: '600' }}>{result.title}</Text>
          {!!result.detail && <Text style={[styles.detail, { color: theme.textColor }]}>{result.detail}</Text>}
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
  button: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignSelf: 'flex-start', marginTop: 8 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  resultBox: { marginTop: 12, padding: 10, borderWidth: 1, borderRadius: 8 },
  detail: { fontSize: 11, opacity: 0.7, marginTop: 6 },
});
