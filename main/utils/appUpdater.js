import { Alert, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { co3Version, GITHUB_REPO, UPDATE_CHECK_INTERVAL_MS } from '../constant';

const LAST_CHECK_KEY = 'appUpdateLastCheck';
const SKIPPED_KEY = 'appUpdateSkippedVersion';
const RATE_LIMIT_KEY = 'appUpdateRateLimited';

// GitHub 匿名 API 限流 60 次/小时。收到 429 后 6 小时内不再自动检查，
// 避免每次启动都打 API 触发限流（手动检查仍可强制触发）。
const RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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
// force=true 时忽略 24h 间隔(用于「关于」页手动检查)。
export async function checkAppUpdate(t, force = false) {
  try {
    const now = Date.now();
    const last = await AsyncStorage.getItem(LAST_CHECK_KEY);
    if (!force && last && now - parseInt(last, 10) < UPDATE_CHECK_INTERVAL_MS) {
      return null;
    }
    // 429 冷却期内自动检查直接跳过（手动检查不受限）
    const rateLimitedAt = await AsyncStorage.getItem(RATE_LIMIT_KEY);
    if (!force && rateLimitedAt && now - parseInt(rateLimitedAt, 10) < RATE_LIMIT_COOLDOWN_MS) {
      return null;
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
    if (res.status === 429 || res.status === 403) {
      // 限流：记录冷却时间，避免每次启动都打 API
      await AsyncStorage.setItem(RATE_LIMIT_KEY, String(now));
      if (force) return `http_${res.status}`;
      return null;
    }
    if (!res.ok) {
      // 手动检查时让用户知道失败原因(启动时仍静默)。
      if (force) return `http_${res.status}`;
      return null;
    }
    const data = await res.json();
    const latestTag = data.tag_name;
    if (!latestTag) return null;

    await AsyncStorage.setItem(LAST_CHECK_KEY, String(now));

    // 本地已是最新或更新,不提示(手动检查返回 'latest' 以便 UI 反馈)。
    if (compareVersions(co3Version, latestTag) <= 0) {
      return force ? 'latest' : null;
    }

    // 用户已选择跳过此版本
    const skipped = await AsyncStorage.getItem(SKIPPED_KEY);
    if (skipped === latestTag) {
      return force ? 'skipped' : null;
    }

    const body = truncate(data.body || '', 200);
    const hint = t('update_open_hint');
    const message = body ? `${body}\n\n${hint}` : hint;

    // 按平台选资产：iOS 取 .ipa，Android 取 .apk——assets[0] 是发布顺序的第一个，
    // iOS 用户拿到 APK 会装不上（2026-08-06 苹果用户反馈"显示的是安卓更新内容"）。
    const isIOS = Platform.OS === 'ios';
    const asset =
      data.assets &&
      data.assets.find(a => (isIOS ? /\.ipa$/i.test(a.name) : /\.apk$/i.test(a.name)));
    const downloadUrl = asset ? asset.browser_download_url : null;
    const mirrorUrl = downloadUrl ? `https://gh-proxy.com/${downloadUrl}` : null;

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
    return 'available';
  } catch (e) {
    console.log('[appUpdater] check failed:', e?.message || e);
    return force ? 'error' : null;
  }
}
