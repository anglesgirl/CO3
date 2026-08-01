/**
 * 匿名使用统计封装 (PostHog)。
 *
 * 设计要点:
 * - PostHog 的 Project API Key 在 POSTHOG_KEY 为空时,所有方法 no-op,
 *   不报错也不影响 App 运行。注册拿到 Key 后填入 constant.js 即可启用。
 * - 通过动态 require 加载 posthog-react-native;SDK 未安装或原生未链接时
 *   降级为 no-op,绝不崩溃。
 * - distinct_id 用本地随机 UUID,不关联任何 AO3 账号或 PII。
 * - 仅上报:启动、活跃心跳、App 版本、系统、语言。不采集阅读内容。
 * - 卸载推断:后台按 distinct_id 的"最后心跳时间 > N 天"判断。
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { POSTHOG_KEY, POSTHOG_HOST, HEARTBEAT_INTERVAL_MS } from '../constant';

let PostHog = null;
let initialized = false;
let heartbeatTimer = null;
let distinctId = null;

const DISTINCT_ID_KEY = 'analytics_distinct_id';

// 动态加载 SDK,失败则保持 null(全程 no-op)。
try {
  // eslint-disable-next-line global-require
  PostHog = require('posthog-react-native').default;
} catch (e) {
  PostHog = null;
}

async function ensureDistinctId() {
  if (distinctId) return distinctId;
  try {
    let id = await AsyncStorage.getItem(DISTINCT_ID_KEY);
    if (!id) {
      // 生成匿名 UUID v4
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      await AsyncStorage.setItem(DISTINCT_ID_KEY, id);
    }
    distinctId = id;
    return id;
  } catch (e) {
    return null;
  }
}

function deviceProps() {
  return {
    app_version: require('../constant').co3Version,
    os: Platform.OS,
    os_version: Platform.Version,
  };
}

/** 初始化统计。enabled=false 时跳过(尊重用户关闭)。 */
export async function initAnalytics(enabled) {
  if (!enabled) return;
  if (initialized) return;
  if (!PostHog || !POSTHOG_KEY) return; // Key 未填 → no-op

  try {
    const id = await ensureDistinctId();
    await PostHog.setup(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      autocapture: false, // 不自动采集,只发我们埋的事件
      maskAllText: true,
      captureScreenViews: false,
    });
    if (id) {
      PostHog.identify(id, deviceProps());
    }
    initialized = true;
  } catch (e) {
    initialized = false;
  }
}

/** 上报事件。未初始化时 no-op。 */
export function track(event, properties = {}) {
  if (!initialized || !PostHog) return;
  try {
    PostHog.capture(event, { ...properties, ...deviceProps() });
  } catch (e) {
    /* 静默失败,统计不应影响 App */
  }
}

/** 启动活跃心跳:前台时定时上报,用于活跃/留存/卸载推断。 */
export function startHeartbeat() {
  stopHeartbeat();
  if (!initialized) return;
  track('app_active');
  heartbeatTimer = setInterval(() => {
    track('app_active');
  }, HEARTBEAT_INTERVAL_MS);
}

/** 停止心跳(切到后台时调用)。 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** 用户在设置里关闭统计时,重置状态并 opt out。 */
export function disableAnalytics() {
  stopHeartbeat();
  if (PostHog && initialized) {
    try { PostHog.optOut(); } catch (e) { /* ignore */ }
  }
  initialized = false;
}
