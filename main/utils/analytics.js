/**
 * Firebase Analytics 自定义事件（自动采集之外）：ECH 启动/自检成功率等。
 *
 * 安全设计（启动闪退的教训）：
 * - Firebase 原生模块**惰性**拿：只在真正打点时 require，不进启动期静态链。
 * - 无模块/抛错/超时一律静默跳过，绝不影响业务，也绝不抛给调用方。
 * - 参数按 Firebase 限制清洗：名 ≤40 字符，字符串值 ≤100 字符。
 */

function fbAnalytics() {
  try {
    // eslint-disable-next-line global-require
    const m = require('@react-native-firebase/analytics');
    return m.default || m;
  } catch {
    return null;
  }
}

function cleanParams(params) {
  const out = {};
  try {
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v === null || v === undefined) return;
      const key = String(k).slice(0, 40);
      if (typeof v === 'string') out[key] = v.slice(0, 100);
      else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
      else {
        try {
          out[key] = JSON.stringify(v).slice(0, 100);
        } catch {
          out[key] = String(v).slice(0, 100);
        }
      }
    });
  } catch {}
  return out;
}

export function trackEvent(name, params = {}) {
  try {
    const fb = fbAnalytics();
    if (!fb || typeof fb.logEvent !== 'function') return;
    fb.logEvent(String(name).slice(0, 40), cleanParams(params)).catch(() => {});
  } catch {}
}
