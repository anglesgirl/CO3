import {
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  echSelfTest,
  getDoh,
  setDoh,
  getCustomIPs,
  setCustomIPs,
  DEFAULT_DOH,
} from '../../web/echKy';

export default function DebugScreen({ route }) {
  const {db, setScreens} = route.params;
  const [sqlCmd, setSqlCmd] = useState('');
  const [logs, setLogs] = useState([]);
  const [doh, setDohInput] = useState('');
  const [ips, setIpsInput] = useState('');

  useEffect(() => {
    getDoh().then(setDohInput);
    getCustomIPs().then(setIpsInput);
  }, []);

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

        <Text style={{ marginTop: 16 }}>ECH proxy — DoH endpoint</Text>
        <TextInput
          style={{ borderColor: '#000', borderWidth: 1, padding: 6, marginTop: 4 }}
          placeholder={DEFAULT_DOH}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setDohInput}
          value={doh}
        />
        <View style={{ flexDirection: 'row', marginTop: 6, gap: 8 }}>
          <TouchableOpacity
            style={{
              backgroundColor: '#111',
              borderRadius: 6,
              paddingVertical: 10,
              paddingHorizontal: 12,
            }}
            onPress={async () => {
              addLog('cmd', `> set DoH = ${doh || '(none)'} and restart proxy...`);
              try {
                await setDoh(doh);
                addLog('success', 'Proxy restarted with new DoH. Run "Test ECH status".');
              } catch (e) {
                addLog('error', e?.message ?? String(e));
              }
            }}
          >
            <Text style={{ color: '#fff' }}>Save & restart</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{
              backgroundColor: '#555',
              borderRadius: 6,
              paddingVertical: 10,
              paddingHorizontal: 12,
            }}
            onPress={() => setDohInput(DEFAULT_DOH)}
          >
            <Text style={{ color: '#fff' }}>Reset default</Text>
          </TouchableOpacity>
        </View>

        <Text style={{ marginTop: 16 }}>
          Preferred edge IP(s) — optional, comma-separated. Only changes the
          route; SNI/ECH stay encrypted. Empty = use DNS.
        </Text>
        <TextInput
          style={{ borderColor: '#000', borderWidth: 1, padding: 6, marginTop: 4 }}
          placeholder="e.g. 104.16.1.1, 104.17.2.2"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setIpsInput}
          value={ips}
        />
        <View style={{ flexDirection: 'row', marginTop: 6, gap: 8 }}>
          <TouchableOpacity
            style={{
              backgroundColor: '#111',
              borderRadius: 6,
              paddingVertical: 10,
              paddingHorizontal: 12,
            }}
            onPress={async () => {
              addLog('cmd', `> set edge IP = ${ips || '(use DNS)'} and restart proxy...`);
              try {
                await setCustomIPs(ips);
                addLog('success', 'Proxy restarted. Run "Test ECH status".');
              } catch (e) {
                addLog('error', e?.message ?? String(e));
              }
            }}
          >
            <Text style={{ color: '#fff' }}>Save IP & restart</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{
              backgroundColor: '#555',
              borderRadius: 6,
              paddingVertical: 10,
              paddingHorizontal: 12,
            }}
            onPress={() => setIpsInput('')}
          >
            <Text style={{ color: '#fff' }}>Clear IP</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={{
            marginTop: 8,
            backgroundColor: '#111',
            borderRadius: 6,
            paddingVertical: 10,
            paddingHorizontal: 12,
            alignSelf: 'flex-start',
          }}
          onPress={async () => {
            addLog('cmd', '> ECH self-test (fetching AO3 through proxy)...');
            try {
              const result = await echSelfTest();
              const ok = result.includes('ECHAccepted=true');
              addLog(ok ? 'success' : 'error', result);
            } catch (e) {
              addLog('error', e?.message ?? String(e));
            }
          }}
        >
          <Text style={{ color: '#fff' }}>Test ECH status</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={{
            marginTop: 8,
            backgroundColor: '#7a3',
            borderRadius: 6,
            paddingVertical: 10,
            paddingHorizontal: 12,
            alignSelf: 'flex-start',
          }}
          onPress={async () => {
            try {
              await AsyncStorage.removeItem('cf_domains');
              addLog('success', 'Cleared Cloudflare/WebView fallback mode. Go back and retry.');
            } catch (e) {
              addLog('error', e?.message ?? String(e));
            }
          }}
        >
          <Text style={{ color: '#fff' }}>Clear CF/WebView fallback</Text>
        </TouchableOpacity>

        <Text style={{ marginTop: 16 }}>Run SQL cmd</Text>
        <TextInput
          style={{ borderColor: '#fff', backgroundColor: "#000", color: "#fff", borderWidth: 1, }}
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