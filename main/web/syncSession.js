import { NativeModules } from 'react-native';
import { setCredsToken, setLastLogin } from '../storage/Credentials';

// 把 WebView 里的 _otwarchive_session 同步到 Keychain，避免 14 天后被 requestManager 清掉
export async function syncSessionFromNative() {
  try {
    const mod = NativeModules.CoCookieModule;
    if (!mod || !mod.syncSessionToJs) return null;
    const token = await mod.syncSessionToJs('https://archiveofourown.org/');
    if (token && token.length > 20) {
      await setCredsToken(token);
      await setLastLogin();
      console.log('[syncSession] synced token len', token.length);
      try { 
        // 可选上报
        fetch('https://log.anglesgirl.eu.org/v1/events', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({app:'co3', event:'js_sync_session', timestamp: new Date().toISOString(), fields:{len: token.length}})
        }).catch(()=>{});
      } catch {}
      return token;
    }
  } catch (e) { console.log('[syncSession] err', e); }
  return null;
}
