import { NativeModules, Platform } from 'react-native';

/**
 * 把关键事件上报到统一诊断通道（原生 `Diagnostics`，经 `CoDiagModule` 转发）。
 *
 * 为什么需要：登录流程横跨 JS（取登录页 → 抽 CSRF token → 提交表单）和原生
 * （ECH 拦截器发请求/收 Set-Cookie）。此前 JS 侧完全没有日志，半个链路是黑的，
 * 出问题只能猜。所有步骤都上报后，一次测试就能定位到具体哪一步断掉。
 *
 * 约定：fields 只传字符串/数字/布尔，不做嵌套对象（RN 桥上层更稳）。
 * 失败一律静默 —— 诊断绝不能影响主流程。
 *
 * iOS：没有 CoDiag 原生模块，走 JS 直发 HTTP 到日志服务器（log 服务器域名
 * 不走 ECH，直连即可）。
 */
const LOG_ENDPOINT = 'https://log.anglesgirl.eu.org/v1/events?app=co3';

let iosLogQueue = Promise.resolve();

function iosDiagEvent(name, fields = {}) {
  // 串行发送，避免并发打爆
  iosLogQueue = iosLogQueue.then(async () => {
    try {
      const body = JSON.stringify({
        event: String(name),
        ts: new Date().toISOString(),
        platform: 'ios',
        ...fields,
      });
      await fetch(LOG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      // 忽略：诊断失败不影响功能
    }
  });
}

export function diagEvent(name, fields = {}) {
  try {
    const { CoDiag } = NativeModules;
    if (CoDiag && typeof CoDiag.event === 'function') {
      CoDiag.event(String(name), fields);
      return;
    }
    // iOS：CoDiag 不存在，走 JS 直发
    if (Platform.OS === 'ios') {
      iosDiagEvent(name, fields);
    }
  } catch (e) {
    // 忽略：诊断失败不影响功能
  }
}

export default diagEvent;
