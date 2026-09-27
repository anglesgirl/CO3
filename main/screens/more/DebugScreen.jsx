import {
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { exportDiagnostics } from '../../utils/logExport';

export default function DebugScreen({ route }) {
  const { db, setScreens } = route.params;
  const [sqlCmd, setSqlCmd] = useState('');
  const [logs, setLogs] = useState([]);
  const [exporting, setExporting] = useState(false);

  const addLog = (type, message) => {
    setLogs(prev => [
      { id: Date.now(), type, message, time: new Date().toLocaleTimeString() },
      ...prev,
    ]);
  };

  const navigation = useNavigation();

  return (
    <ScrollView style={{ flex: 1, padding: 12, backgroundColor: '#fff' }}>
      <Text style={{ fontSize: 25 }}>Debug Screen</Text>
      <Text>
        If you don't know what you are doing here, press the red text below.
      </Text>
      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={{ color: '#ff0000' }}>Close debug menu</Text>
      </TouchableOpacity>

      {/* 一键导出诊断日志：原生 trace + JS 配置 + 快速自检 + console，系统分享发走 */}
      <View
        style={{
          marginTop: 16,
          padding: 12,
          borderRadius: 8,
          backgroundColor: '#e7f5ff',
          borderWidth: 1,
          borderColor: '#4dabf7',
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: '700', color: '#1c7ed6' }}>
          网络/ECH 有问题？先导日志
        </Text>
        <Text style={{ marginTop: 4, fontSize: 12, color: '#555' }}>
          会当场发一次 AO3 请求（8s 超时）复现问题，再把原生+JS 全部日志拼成一个文本分享/复制。
        </Text>
        <TouchableOpacity
          style={{
            marginTop: 8,
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 6,
            backgroundColor: exporting ? '#a5d8ff' : '#1c7ed6',
            alignSelf: 'flex-start',
          }}
          onPress={async () => {
            if (exporting) return;
            setExporting(true);
            addLog('cmd', '> 导出诊断日志…');
            try {
              const result = await exportDiagnostics();
              addLog(
                'success',
                result === 'copied'
                  ? '分享不可用，日志已复制到剪贴板（可直接粘贴发送）'
                  : '已拉起系统分享，把日志发回给开发者即可',
              );
            } catch (e) {
              addLog('error', `导出失败: ${e.message}`);
            } finally {
              setExporting(false);
            }
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>
            {exporting ? '正在导出…' : '导出诊断日志（分享）'}
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={{ marginTop: 16 }}>Run SQL cmd</Text>
      <TextInput
        style={{
          borderColor: '#fff',
          backgroundColor: '#000',
          color: '#fff',
          borderWidth: 1,
        }}
        placeholder="UPDATE works SET..."
        onChangeText={setSqlCmd}
        value={sqlCmd}
      />
      <TouchableOpacity
        onPress={async () => {
          addLog('cmd', `> ${sqlCmd}`);
          try {
            const res = await db.executeSql(sqlCmd);
            const rowsAffected = res[0]?.rowsAffected ?? 0;
            const rows = res[0]?.rows?._array ?? [];
            const rawResult = res[0]?.rows?.raw?.() ?? [];

            addLog('cmd', `> ${sqlCmd}`);

            const resultRows = rows.length > 0 ? rows : rawResult;

            if (resultRows.length > 0) {
              addLog('result', JSON.stringify(resultRows, null, 2));
            } else if (rowsAffected > 0) {
              addLog('success', `OK — ${rowsAffected} row(s) affected`);
            } else {
              addLog('success', 'OK — no rows returned or affected');
            }
          } catch (e) {
            addLog('error', e.message);
          }
        }}
      >
        <Text>Execute SQL</Text>
      </TouchableOpacity>

      <View style={{ marginTop: 20 }}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: '600' }}>Log</Text>
          {logs.length > 0 && (
            <TouchableOpacity onPress={() => setLogs([])}>
              <Text style={{ color: '#888', fontSize: 13 }}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>

        <ScrollView
          style={{
            maxHeight: 300,
          }}
          nestedScrollEnabled
        >
          {logs.length === 0 ? (
            <Text style={{ color: '#555', fontSize: 13 }}>
              No output yet...
            </Text>
          ) : (
            logs.map(log => (
              <View key={log.id} style={{ marginBottom: 6 }}>
                <Text
                  style={{
                    fontSize: 12,
                    color:
                      log.type === 'error'
                        ? '#ff6b6b'
                        : log.type === 'success'
                        ? '#69db7c'
                        : log.type === 'cmd'
                        ? '#74c0fc'
                        : '#86911e',
                  }}
                >
                  <Text style={{ color: '#555' }}>[{log.time}] </Text>
                  {log.message}
                </Text>
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </ScrollView>
  );
}