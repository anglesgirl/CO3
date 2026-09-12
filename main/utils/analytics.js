import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 匿名统计（PostHog）。
 *
 * 设计取舍：
 * - **不用 PostHog 的 RN SDK，直接打 HTTP `/capture/`** —— 少一个原生依赖、
 *   少一次 pod/gradle 集成，构建更稳；事件字段与 SDK 版一致，后台照常能看。
 * - Host 走用户自有反代 `https://e.anglesya.win`（大陆可直连，
 *   不依赖被墙的 Google/Cloudflare 端点）。
 * - 两个 App 共用同一个 PostHog 项目，靠属性 `app` 区分，此处固定为 `co3`。
 * - **key 是客户端公开信息**（会打进包里），不属于机密。
 * - **统计必须可关闭**：关闭后直接 return，不产生任何网络请求；
 *   且**任何异常都静默**，永不阻塞或影响主流程。
 *
 * ⚠️ key 就位前不要改成假值去"试着发" —— 占位 key 时**直接不发请求**，
 * 避免把无效请求打到反代上。
 */

// 占位符：拿到真实 key 后替换（或改 constant.js）
const PLACEHOLDER_KEY = 'phc_PLACEHOLDER_REPLACE_ME';

let POSTHOG_KEY = PLACEHOLDER_KEY;
let POSTHOG_HOST = 'https://e.anglesya.win';

try {
  // 允许通过 constant.js 覆盖（与旧版 CO3 的习惯一致）
  const c = require('../constant');
  if (c?.posthogKey) POSTHOG_KEY = c.posthogKey;
  if (c?.posthogHost) POSTHOG_HOST = c.posthogHost;
} catch (e) {
  // constant.js 没有也可以，用上面的默认值
}

const ANON_KEY = 'analytics_anon_id';
const ENABLED_KEY = 'analytics_enabled';

let anonId = null;
let enabled = true;

function uuid() {
  // 够用的匿名随机 ID（不追求密码学强度，仅作去重/会话聚合）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function ensureInit() {
  if (anonId) return;
  try {
    let v = await AsyncStorage.getItem(ANON_KEY);
    if (!v) {
      v = uuid();
      await AsyncStorage.setItem(ANON_KEY, v);
    }
    anonId = v;
    const en = await AsyncStorage.getItem(ENABLED_KEY);
    if (en === '0') enabled = false;
  } catch (e) {
    anonId = uuid();
  }
}

/** 统计开关（设置页调用）。 */
export async function setAnalyticsEnabled(on) {
  enabled = !!on;
  try {
    await AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch (e) {
    /* 静默 */
  }
}

export async function isAnalyticsEnabled() {
  await ensureInit();
  return enabled;
}

function clientInfo() {
  return {
    app: 'co3',
    platform: Platform.OS,
    os_version: String(Platform.Version),
  };
}

/**
 * 上报一个事件。**永不抛异常、永不阻塞**。
 * @param {string} name 事件名（蛇形，如 ech_proxy_start）
 * @param {object} props 附加属性（值会转成字符串并截断，避免超大 payload）
 */
export function trackEvent(name, props = {}) {
  // 注意：不 await，调用方不需要等；失败一律忽略。
  (async () => {
    try {
      await ensureInit();
      if (!enabled) return;
      if (!POSTHOG_KEY || POSTHOG_KEY === PLACEHOLDER_KEY) return; // key 未就位：不发请求

      const safe = {};
      Object.keys(props || {}).forEach((k) => {
        const v = props[k];
        if (v === null || v === undefined) return;
        safe[k] = String(v).slice(0, 200);
      });

      const body = JSON.stringify({
        api_key: POSTHOG_KEY,
        event: String(name),
        distinct_id: anonId,
        properties: { ...clientInfo(), ...safe },
        timestamp: new Date().toISOString(),
      });

      await fetch(`${POSTHOG_HOST}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      // 统计永远不能影响功能
    }
  })();
}

export default { trackEvent, setAnalyticsEnabled, isAnalyticsEnabled };
