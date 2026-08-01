/**
 * 匿名使用统计封装 (PostHog)。
 *
 * 设计原则:
 * 1. 普通页面/点击事件随便打,避免循环内疯狂打点;
 * 2. Session 会话回放采样 8% 用户,不 100% 开启;
 * 3. 超长属性做字符串截断 (max 200 字符),禁止把整篇小说丢进埋点;
 * 4. 提供开关,允许用户关闭数据采集 (analyticsEnabled);
 * 5. 使用自有域名代理上报 (e.anglesya.win),减少丢事件;
 * 6. 断网时 SDK 自动用 AsyncStorage 本地缓存,网络恢复后补发。
 *
 * - posthog-react-native v4.x 使用 `new PostHog(apiKey, options)` 构造函数。
 * - distinct_id 用本地随机 UUID,不关联任何 AO3 账号或 PII。
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { POSTHOG_KEY, POSTHOG_HOST, HEARTBEAT_INTERVAL_MS } from '../constant';

let PostHogClass = null;
let posthog = null;       // PostHog 实例 (v4.x)
let initialized = false;
let heartbeatTimer = null;
let distinctId = null;

const DISTINCT_ID_KEY = 'analytics_distinct_id';
const MAX_PROP_LENGTH = 200;             // 属性值最大长度

// 动态加载 SDK,失败则保持 null(全程 no-op)。
try {
  // eslint-disable-next-line global-require
  PostHogClass = require('posthog-react-native').default;
} catch (e) {
  PostHogClass = null;
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

/**
 * 截断超长属性值,防止把整篇小说/章节内容丢进埋点。
 * 字符串超过 MAX_PROP_LENGTH 时截断并加省略号。
 */
function truncateProps(props) {
  const out = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' && value.length > MAX_PROP_LENGTH) {
      out[key] = value.slice(0, MAX_PROP_LENGTH) + '…';
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 初始化统计。enabled=false 时跳过(尊重用户关闭)。 */
export async function initAnalytics(enabled) {
  if (!enabled) return;
  if (initialized) return;
  if (!PostHogClass || !POSTHOG_KEY) return; // Key 未填 → no-op

  try {
    // v4.x: 使用构造函数创建实例。
    // 注意: 不传 enableSessionReplay / sessionReplayConfig —— 未安装
    // posthog-react-native-session-replay 原生插件时,这些选项可能
    // 触发 native 模块调用导致闪退。会话回放功能等装好插件后再开。
    posthog = new PostHogClass(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      autocapture: false,        // 原则 1: 不自动采集,只发手动埋的事件
      maskAllText: true,         // 隐私: 遮挡文本
      captureScreenViews: false,
    });

    const id = await ensureDistinctId();
    if (id) {
      posthog.identify(id, deviceProps());
    }
    initialized = true;
  } catch (e) {
    console.warn('[Analytics] init failed:', e?.message ?? e);
    initialized = false;
  }
}

/**
 * 上报事件。未初始化时 no-op。
 * 原则 3: 所有属性值自动截断到 200 字符,防止超长内容。
 */
export function track(event, properties = {}) {
  if (!initialized || !posthog) return;
  try {
    posthog.capture(event, { ...truncateProps(properties), ...deviceProps() });
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
  if (posthog && initialized) {
    try { posthog.optOut(); } catch (e) { /* ignore */ }
  }
  initialized = false;
}
