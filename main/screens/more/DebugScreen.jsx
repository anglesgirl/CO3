import { ScrollView, Share, Text, TouchableOpacity, View } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import RNFS from 'react-native-fs';
import { echSelfTest } from '../../web/echKy';
import {
  clearDebugLogs,
  debugLog,
  getDebugLogs,
  isDebugEnabled,
  setDebugEnabled,
} from '../../utils/debugLog';

function pad(n) {
  return String(n).padStart(2, '0');
}

function logFileName() {
  const d = new Date();
  return `co3-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
}

export default function DebugScreen() {
  const navigation = useNavigation();
  const [enabled, setEnabled] = useState(false);
  const [logs, setLogs] = useState([]);
  const [shareState, setShareState] = useState('');

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

  /**
   * 导出为 .txt 并调系统分享。
   * 之前只能长按选中文本复制（几十条日志几乎没法操作），发给开发者时
   * 还得手动转成文档。写成纯文本文件再 Share 最省事，微信/Telegram
   * 都能直接当附件发。
   */
  const shareAsTxt = async () => {
    try {
      const current = await getDebugLogs();
      if (!current.length) {
        setShareState('暂无日志可导出');
        return;
      }
      const header = [
        `CO3 debug log`,
        `exported: ${new Date().toISOString()}`,
        `entries: ${current.length}`,
        ''.padEnd(40, '-'),
        '',
      ].join('\n');
      const body = current
        .map(log => `[${log.time}] ${log.scope}: ${log.message}`)
        .join('\n\n');

      const path = `${RNFS.CachesDirectoryPath}/${logFileName()}`;
      await RNFS.writeFile(path, header + body, 'utf8');

      setShareState('正在分享…');
      // iOS 需要 file:// 前缀才能被分享面板接受；Android 用 url 亦可。
      await Share.share({
        url: `file://${path}`,
        title: 'CO3 debug log',
        message: 'CO3 调试日志',
      });
      setShareState(`已导出：${path.split('/').pop()}`);
    } catch (error) {
      setShareState(`导出失败：${error?.message ?? String(error)}`);
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
      <TouchableOpacity style={[styles.button, styles.shareButton]} onPress={shareAsTxt}>
        <Text style={styles.buttonText}>📤 导出日志为 txt 并分享</Text>
      </TouchableOpacity>
      {!!shareState && (
        <Text style={{ marginTop: 8, fontSize: 12, color: '#475467' }}>{shareState}</Text>
      )}
      <View style={{ flexDirection: 'row', gap: 18, marginTop: 16 }}>
        <TouchableOpacity onPress={refresh}><Text>刷新</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { await clearDebugLogs(); await refresh(); }}><Text style={{ color: '#b42318' }}>清空</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.goBack()}><Text>返回</Text></TouchableOpacity>
      </View>
      <Text selectable style={styles.logText}>
        {logs.length ? logs.map(log => `[${log.time}] ${log.scope}: ${log.message}`).join('\n\n') : '暂无日志'}
      </Text>
    </ScrollView>
  );
}

const styles = {
  button: { backgroundColor: '#182230', borderRadius: 6, marginTop: 10, padding: 11 },
  shareButton: { backgroundColor: '#1B6EF3' },
  buttonText: { color: '#fff', textAlign: 'center', fontWeight: '600' },
  logText: { color: '#182230', fontSize: 12, marginTop: 18, paddingBottom: 36 },
};
