import { Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { co3Version, GITHUB_REPO, UPDATE_CHECK_INTERVAL_MS } from '../constant';

const LAST_CHECK_KEY = 'appUpdateLastCheck';
const SKIPPED_KEY = 'appUpdateSkippedVersion';

// 比较形如 "B0.0.20" / "V1.2.3" 的版本号。
// 返回 >0 表示 b 比 a 新,<0 表示 b 更旧,0 表示相同。
function compareVersions(a, b) {
  const pa = String(a).replace(/^[BV]/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^[BV]/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return db - da;
  }
  return 0;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// 启动时检查 GitHub latest release 是否有新版本。
// 24h 内只查一次;用户点「以后再说」会跳过该版本,直到出现更新的版本。
// 全程静默失败:网络错误、限流、解析异常都不打扰用户。
export async function checkAppUpdate(t) {
  try {
    const now = Date.now();
    const last = await AsyncStorage.getItem(LAST_CHECK_KEY);
    if (last && now - parseInt(last, 10) < UPDATE_CHECK_INTERVAL_MS) {
      return;
    }

    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'CO3-App-Updater',
        },
      },
    );
    if (!res.ok) return;
    const data = await res.json();
    const latestTag = data.tag_name;
    if (!latestTag) return;

    await AsyncStorage.setItem(LAST_CHECK_KEY, String(now));

    // 本地已是最新或更新,不提示
    if (compareVersions(co3Version, latestTag) <= 0) return;

    // 用户已选择跳过此版本
    const skipped = await AsyncStorage.getItem(SKIPPED_KEY);
    if (skipped === latestTag) return;

    const body = truncate(data.body || '', 200);
    const hint = t('update_open_hint');
    const message = body ? `${body}\n\n${hint}` : hint;

    // GitHub 直连在国内常打不开,提供镜像入口。
    // ghproxy 会把 release 页面里的资源按相同路径代理。
    const mirrorUrl = data.html_url
      ? `https://ghproxy.com/${data.html_url}`
      : null;

    const buttons = [
      {
        text: t('update_later_button'),
        onPress: async () => {
          await AsyncStorage.setItem(SKIPPED_KEY, latestTag);
        },
      },
      {
        text: t('update_view_button'),
        onPress: () => {
          if (data.html_url) Linking.openURL(data.html_url);
        },
      },
    ];
    if (mirrorUrl) {
      buttons.push({
        text: t('update_mirror_button'),
        onPress: () => Linking.openURL(mirrorUrl),
      });
    }

    Alert.alert(
      t('update_available_title', { version: latestTag }),
      message,
      buttons,
      { cancelable: true },
    );
  } catch (e) {
    console.log('[appUpdater] check failed:', e?.message || e);
  }
}
