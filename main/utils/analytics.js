/**
 * 匿名使用统计 — 轻量 HTTP 客户端 (无 SDK 依赖)。
 *
 * 之前使用 posthog-react-native SDK,但 SDK 内部 require('expo-file-system')
 * 会触发 requireNativeModule('FileSystem'),而本项目没有对应的原生模块,
 * 导致 JavascriptException 闪退。多次尝试 (customStorage / persistence:'memory')
 * 均无法彻底避免 SDK 加载链中的 native module 访问。
 *
 * 最终方案: 完全弃用 SDK,直接用 fetch 调 PostHog /batch/ API。
 * 只需要统计活跃用户数,不需要 SDK 的高级功能 (session replay / feature flags)。
 *
 * 设计原则:
 * 1. 普通页面/点击事件随便打,避免循环内疯狂打点;
 * 2. 超长属性做字符串截断 (max 200 字符),禁止把整篇小说丢进埋点;
 * 3. 提供开关,允许用户关闭数据采集 (analyticsEnabled);
 * 4. 使用自有域名代理上报 (e.anglesya.win),减少丢事件;
 * 5. 断网时事件缓存在内存队列,网络恢复后批量补发;
 * 6. 全程 fire-and-forget,永不阻塞 UI,永不抛异常。
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { POSTHOG_KEY, POSTHOG_HOST, HEARTBEAT_INTERVAL_MS, co3Version } from '../constant';

let initialized = false;
let heartbeatTimer = null;
let distinctId = null;

// 内存事件队列: 断网时缓存,网络恢复后批量补发
const eventQueue = [];
const QUEUE_MAX = 50;           // 最多缓存 50 条,防止内存膨胀
const FLUSH_INTERVAL_MS = 30000; // 每 30 秒尝试批量上报
let flushTimer = null;

const DISTINCT_ID_KEY = 'analytics_distinct_id';
const MAX_PROP_LENGTH = 200;

// --- distinct ID ---

async function ensureDistinctId() {
  if (distinctId) return distinctId;
  try {
    let id = await AsyncStorage.getItem(DISTINCT_ID_KEY);
    if (!id) {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      await AsyncStorage.setItem(DISTINCT_ID_KEY, id);
    }
    distinctId = id;
    return id;
  } catch {
    return null;
  }
}

// --- helpers ---

function deviceProps() {
  return {
    app_version: co3Version,
    os: Platform.OS,
    os_version: Platform.Version,
  };
}

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

// --- HTTP 上报 ---

// 直接用 fetch,不走 echKy。原因:
// 1. echKy 会把所有 HTTPS 请求路由到 ECH 代理,而 PostHog 端点不是 AO3,
//    走代理反而增加延迟和故障点。
// 2. e.anglesya.win 是自有域名,不会被墙,直连即可。
// 3. 统计是 fire-and-forget,不需要可靠传输。
async function flushQueue() {
  if (eventQueue.length === 0) return;
  if (!distinctId) return;

  // 取出当前队列快照
  const batch = eventQueue.splice(0, eventQueue.length);

  try {
    const res = await fetch(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        historical_migration: false,
        batch: batch.map(evt => ({
          event: evt.event,
          distinct_id: distinctId,
          properties: { ...evt.properties, ...deviceProps() },
          timestamp: evt.timestamp,
        })),
      }),
    });
    if (!res.ok) {
      // 上报失败: 把事件放回队列,下次重试
      // 但如果队列已满就丢弃,防止内存无限增长
      const space = QUEUE_MAX - eventQueue.length;
      if (space > 0) eventQueue.unshift(...batch.slice(0, space));
    }
  } catch {
    // 网络错误: 放回队列
    const space = QUEUE_MAX - eventQueue.length;
    if (space > 0) eventQueue.unshift(...batch.slice(0, space));
  }
}

function startFlushTimer() {
  stopFlushTimer();
  flushTimer = setInterval(() => {
    flushQueue().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// --- 公共 API ---

/**
 * 初始化统计。enabled=false 时跳过 (尊重用户关闭)。
 */
export async function initAnalytics(enabled) {
  if (!enabled) return;
  if (initialized) return;
  if (!POSTHOG_KEY) return;

  try {
    const id = await ensureDistinctId();
    if (!id) return;
    initialized = true;
    startFlushTimer();
    console.log('[Analytics] initialized (direct HTTP mode, no SDK)');
  } catch (e) {
    console.warn('[Analytics] init failed:', e?.message ?? e);
    initialized = false;
  }
}

/**
 * 上报事件。未初始化时 no-op。
 * 事件进入内存队列,由 flushTimer 定期批量上报。
 * 原则 3: 所有属性值自动截断到 200 字符。
 */
export function track(event, properties = {}) {
  if (!initialized) return;
  try {
    const evt = {
      event,
      properties: truncateProps(properties),
      timestamp: new Date().toISOString(),
    };
    // 队列已满: 丢弃最旧的事件
    if (eventQueue.length >= QUEUE_MAX) eventQueue.shift();
    eventQueue.push(evt);
    // 如果积攒了 10 条以上,立即 flush
    if (eventQueue.length >= 10) {
      flushQueue().catch(() => {});
    }
  } catch {
    /* 静默失败,统计不应影响 App */
  }
}

/**
 * 启动活跃心跳: 前台时定时上报,用于活跃/留存/卸载推断。
 */
export function startHeartbeat() {
  stopHeartbeat();
  if (!initialized) return;
  track('app_active');
  heartbeatTimer = setInterval(() => {
    track('app_active');
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * 停止心跳 (切到后台时调用),并 flush 剩余事件。
 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 用户在设置里关闭统计时,停止上报。
 */
export function disableAnalytics() {
  stopHeartbeat();
  stopFlushTimer();
  flushQueue().catch(() => {}); // 最后尝试 flush
  initialized = false;
}
