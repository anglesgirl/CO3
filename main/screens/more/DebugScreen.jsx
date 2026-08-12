import {
  ScrollView, Text, TouchableOpacity, View, Alert,
} from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { echSelfTest } from '../../web/echKy';
import {
  clearDebugLogs,
  debugLog,
  getDebugLogs,
  isDebugEnabled,
  setDebugEnabled,
} from '../../utils/debugLog';
import Share from 'react-native-share';
import RNFS from 'react-native-fs';

export default function DebugScreen() {
  const navigation = useNavigation();
  const [enabled, setEnabled] = useState(false);
  const [logs, setLogs] = useState([]);

  const refresh = useCallback(async () => {
    setEnabled(await isDebugEnabled());
    setLogs(await getDebugLogs());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const toggle = async () => {
    const next = !enabled;
    await setDebugEnabled(next);
    setEnabled(next);
    if (next) await debugLog('debug', 'Debug logging enabled');
    await refresh();
  };

  const selfTest = async () => {
    try {
      const result = await echSelfTest();
      await debugLog('ECH', result);
    } catch (error) {
      await debugLog('ECH', `Self-test failed: ${error?.message ?? String(error)}`);
    }
    await refresh();
  };

  const shareLogs = async () => {
    try {
      const logText = logs.length
        ? logs.map(log => `[${log.time}] ${log.scope}: ${log.message}`).join('\n\n')
        : '暂无日志';
      
      const fileName = `CO3-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
      const filePath = `${RNFS.CacheDirectoryPath}/${fileName}`;
      
      await RNFS.writeFile(filePath, logText, 'utf8');
      
      await Share.open({
        title: 'CO3 调试日志',
        subject: 'CO3 Debug Logs',
        url: `file://${filePath}`,
        filename: fileName,
      });
    } catch (error) {
      console.warn('分享日志失败:', error);
      Alert.alert('分享失败', error?.message ?? String(error));
    }
  };

  const copyLogs = async () => {
    try {
      const logText = logs.length
        ? logs.map(log => `[${log.time}] ${log.scope}: ${log.message}`).join('\n\n')
        : '暂无日志';
      await RNFS.writeFile(
        `${RNFS.CacheDirectoryPath}/CO3-debug-temp.txt`,
        logText,
        'utf8'
      );
      // 在 RN 中无法直接写入剪贴板，通过 Share 分享纯文本作为替代
      await Share.open({
        title: 'CO3 调试日志',
        subject: 'CO3 Debug Logs',
        message: logText,
      });
    } catch (error) {
      console.warn('复制日志失败:', error);
      Alert.alert('复制失败', error?.message ?? String(error));
    }
  };

  return (
    <ScrollView style={{ flex: 1, padding: 16, backgroundColor: '#fff' }}>
      <Text style={{ fontSize: 24, fontWeight: '700' }}>Debug</Text>
      <Text style={{ marginTop: 8 }}>状态：{enabled ? '已开启' : '已关闭'}</Text>
      <TouchableOpacity style={styles.button} onPress={toggle}>
        <Text style={styles.buttonText}>{enabled ? '关闭日志' : '开启日志'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.button} onPress={selfTest}>
        <Text style={styles.buttonText}>测试 ECH</Text>
      </TouchableOpacity>
      <View style={{ flexDirection: 'row', gap: 18, marginTop: 16 }}>
        <TouchableOpacity onPress={refresh}><Text>刷新</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { await clearDebugLogs(); await refresh(); }}><Text style={{ color: '#b42318' }}>清空</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text>返回</Text></TouchableOpacity>
      </View>
      <View style={{ flexDirection: 'row', gap: 18, marginTop: 12 }}>
        <TouchableOpacity style={styles.button} onPress={shareLogs}>
          <Text style={styles.buttonText}>分享日志文件</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={copyLogs}>
          <Text style={styles.buttonText}>复制日志文本</Text>
        </TouchableOpacity>
      </View>
      <Text selectable style={styles.logText}>
        {logs.length ? logs.map(log => `[${log.time}] ${log.scope}: ${log.message}`).join('\n\n') : '暂无日志'}
      </Text>
    </ScrollView>
  );
}

const styles = {
  button: { backgroundColor: '#182230', borderRadius: 6, marginTop: 10, padding: 11 },
  buttonText: { color: '#fff', textAlign: 'center', fontWeight: '600' },
  logText: { color: '#182230', fontSize: 12, marginTop: 18, paddingBottom: 36 },
};