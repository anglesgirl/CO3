/**
 * 远程诊断日志 —— 直接上报到我们自己的接收服务（log.anglesgirl.eu.org）。
 *
 * 为什么需要它：iOS/Android 上「ECH 没起来 / 没联网」这类问题，原来的日志
 * 只进 console（要连调试器才看得到）和 PostHog（看不到细节），出问题时
 * 完全拿不到现场。这里把关键节点推到我们能查的接口，用户装包即用、零配置。
 *
 * 接收端约束（改这里之前先看 /root/.hermes/scripts/diagnostics_receiver.py）：
 * - 一条 POST 一个事件：{app, event, timestamp, fields}
 * - 接收端会对 url / full_url / cookie(s) / token / password / secret /
 *   authorization / request_body / response_body 这些 key 整体脱敏 →
 *   所以**别用 url 当字段名**（会被替换成 [redacted]），域名一律用 host
 * - 限流 120 次/分钟/IP：本地节流到 ~50 次/分钟，超出丢弃（日志不值得拖垮业务）
 * - 失败静默、不重试、绝不 await 阻塞调用方
 */
import { Platform } from 'react-native';

const ENDPOINT = 'https://log.anglesgirl.eu.org/v1/events';
// 接收端按 app 分目录落盘：/var/lib/hermes-diagnostics/<app>/<date>.jsonl
const APP = Platform.OS === 'ios' ? 'co3-ios' : 'co3-android';
const MIN_INTERVAL_MS = 1200; // ≈50 条/分钟，留足余量
const TIMEOUT_MS = 8000;
const QUEUE_LIMIT = 40;
const STR_MAX = 400;

const SENSITIVE = /^(url|full_url|cookie|cookies|token|password|secret|authorization|request_body|response_body)$/i;

const queue = [];
let lastSentAt = 0;
let draining = false;
let dropped = 0;
let sent = 0;

export function remoteLogStats() {
  return { queued: queue.length, sent, dropped };
}

function normalize(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.length > STR_MAX ? `${value.slice(0, STR_MAX)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const s = JSON.stringify(value);
    return s.length > STR_MAX ? `${s.slice(0, STR_MAX)}…` : s;
  } catch {
    return String(value).slice(0, STR_MAX);
  }
}

function safeFields(fields) {
  const out = {};
  try {
    Object.keys(fields || {}).forEach((key) => {
      if (SENSITIVE.test(key)) return; // 别把会被脱敏的键名送过去，换个名字重发
      const v = normalize(fields[key]);
      if (v !== undefined) out[key] = v;
    });
  } catch {}
  return out;
}

async function post(event) {
  // AbortController 在 RN >= 0.6x 可用；不可用时退化为无超时（fetch 自身会超时失败）
  let timer = null;
  let signal;
  try {
    if (typeof AbortController === 'function') {
      const ctrl = new AbortController();
      signal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    }
  } catch {}
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal,
    });
    sent += 1;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const wait = lastSentAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const event = queue.shift();
      lastSentAt = Date.now();
      try {
        await post(event);
      } catch {
        // 静默：日志上报失败绝不影响业务，也不重试（避免打爆自己的服务）
      }
    }
  } finally {
    draining = false;
  }
}

/** 记一条诊断事件。同步返回，绝不抛异常。 */
export function rlog(event, fields = {}) {
  try {
    if (queue.length >= QUEUE_LIMIT) {
      queue.shift();
      dropped += 1;
    }
    queue.push({
      app: APP,
      event: String(event).slice(0, 64),
      timestamp: new Date().toISOString(),
      fields: safeFields(fields),
    });
    drain();
  } catch {}
}

/** 记一条错误（把 Error/字符串统一成 message + stack 头几行）。 */
export function rlogError(event, error, fields = {}) {
  const message = error && error.message ? error.message : String(error);
  const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 3).join(' | ') : undefined;
  rlog(event, { ...fields, error: message, stack });
}

/** 平台/环境快照，便于把不同设备的日志区分开（版本号从原生取，取不到就算了）。 */
export function logEnvOnce(tag = 'env') {
  rlog(tag, {
    platform: Platform.OS,
    version: Platform.Version,
    stats: remoteLogStats(),
  });
}
