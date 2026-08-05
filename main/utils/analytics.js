/**
 * 匿名使用统计 (PostHog v4.61.3)
 *
 * 埋点事件：
 * - app_launch: 应用启动
 * - app_active: 应用在前台运行（心跳）
 * - app_background: 应用进入后台
 * - app_uninstall: 卸载前最后心跳
 *
 * 设计原则:
 * 1. 不自动采集，只上报手动埋的事件
 * 2. 超长属性做字符串截断 (max 200 字符)
 * 3. 提供开关，允许用户关闭数据采集
 * 4. 使用自有域名代理上报 (e.anglesya.win)
 * 5. 每个事件自动添加客户端信息（设备、OS、版本）
 * 6. 永不阻塞 UI，异常静默失败
 */

import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { POSTHOG_KEY, POSTHOG_HOST, HEARTBEAT_INTERVAL_MS, co3Version } from '../constant';

let PostHogClass = null;
let posthog = null;
let initialized = false;
let heartbeatTimer = null;
let distinctId = null;
let appState = null;

const DISTINCT_ID_KEY = 'analytics_distinct_id';
const MAX_PROP_LENGTH = 200;

// 动态加载 SDK
try {
  // eslint-disable-next-line global-require
  PostHogClass = require('posthog-react-native').default;
} catch (e) {
  PostHogClass = null;
}

/**
 * 生成或获取匿名设备 ID
 */
async function ensureDistinctId() {
  if (distinctId) return distinctId;
  try {
    let id = await AsyncStorage.getItem(DISTINCT_ID_KEY);
    if (!id) {
      // 生成 UUID v4
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

/**
 * 获取客户端信息（设备、系统、应用版本）
 */
function getClientInfo() {
  return {
    app: 'co3',
    app_version: co3Version,
    os: Platform.OS,
    os_version: String(Platform.Version),
    platform: Platform.OS === 'android' ? 'Android' : 'iOS',
  };
}

/**
 * 截断超长属性值，防止把整篇小说丢进埋点
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

/**
 * 初始化统计模块。enabled=false 时跳过。
 * 在 App 启动时调用。
 */
export async function initAnalytics(enabled) {
  if (!enabled) return;
  if (initialized) return;
  if (!PostHogClass || !POSTHOG_KEY) return;

  try {
    posthog = new PostHogClass(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      autocapture: false,
      maskAllText: true,
      captureScreenViews: false,
      customStorage: AsyncStorage,
    });

    const id = await ensureDistinctId();
    if (id) {
      posthog.identify(id, getClientInfo());
    }

    initialized = true;

    // 上报应用启动事件
    track('app_launch', {});

    // 监听应用前后台切换
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    // 保存订阅以便后续清理
    if (!global.appStateSubscription) {
      global.appStateSubscription = subscription;
    }
  } catch (e) {
    console.warn('[Analytics] init failed:', e?.message ?? e);
    initialized = false;
  }
}

/**
 * 处理应用前后台切换
 */
function handleAppStateChange(nextAppState) {
  if (appState?.match(/inactive|background/) && nextAppState === 'active') {
    // 从后台返回前台
    track('app_active', {});
    startHeartbeat();
  } else if (appState === 'active' && nextAppState.match(/inactive|background/)) {
    // 进入后台
    track('app_background', {});
    stopHeartbeat();
  }
  appState = nextAppState;
}

/**
 * 上报事件。未初始化时 no-op。
 * 所有属性值自动截断到 200 字符。
 */
export function track(event, properties = {}) {
  if (!initialized || !posthog) return;
  try {
    const fullProps = {
      ...truncateProps(properties),
      ...getClientInfo(),
    };
    posthog.capture(event, fullProps);
  } catch (e) {
    // 静默失败，统计不应影响 App
  }
}

/**
 * 启动活跃心跳：前台时定时上报，用于活跃/留存统计
 */
export function startHeartbeat() {
  stopHeartbeat();
  if (!initialized) return;
  heartbeatTimer = setInterval(() => {
    track('app_active', {});
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * 停止心跳（进入后台时调用）
 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 卸载前的清理：上报最后的应用状态，关闭监听
 */
export async function cleanupAnalytics() {
  stopHeartbeat();
  if (posthog && initialized) {
    try {
      // 上报卸载前的最后事件
      await new Promise(resolve => {
        track('app_uninstall', {});
        // 给 SDK 时间flush事件
        setTimeout(resolve, 500);
      });
    } catch (e) {
      // ignore
    }
  }
  
  // 移除应用状态监听
  if (global.appStateSubscription) {
    global.appStateSubscription.remove();
    global.appStateSubscription = null;
  }
  
  initialized = false;
}

/**
 * 用户在设置里关闭统计时调用
 */
export function disableAnalytics() {
  stopHeartbeat();
  if (posthog && initialized) {
    try {
      posthog.optOut();
    } catch (e) {
      // ignore
    }
  }
  initialized = false;
}

/**
 * 导出自定义事件追踪函数，供外部使用
 * 用法: trackEvent('feature_used', { feature_name: 'search' })
 */
export function trackEvent(eventName, eventProps = {}) {
  track(eventName, eventProps);
}
