/**
 * 诊断日志导出（一键分享给开发者）。
 *
 * 用法：调试页点"导出诊断日志" → 这里把【原生侧 + JS 侧】所有关键信息拼成一个
 * 文本 → 走系统分享（微信/邮件等）发出去。用户不用自己翻日志。
 *
 * 为什么需要 console 环形缓冲：ECH 链路的关键日志（echKy.js / requestManager 等）
 * 大量走 console.log / console.warn（如 `[ECH] proxy started on ...`、`[ECH] ← 403`）。
 * 这些在正式包（release）里用户看不到。这里从模块加载起捕获 console 到内存，
 * 导出时一并带上 —— 重启后 JS 日志丢失但原生 trace 已落盘，两头互补。
 */
import { NativeModules, Platform } from 'react-native';
import { getDoh, getCustomIPs, getLastStartError, getEchStatus, getJarInfo } from '../web/echKy';
import { ao3Text } from '../web/ao3Transport';
import { remoteLogStats } from './remoteLog';

// ---- console 环形缓冲 ----
const CONSOLE_MAX = 600;
const consoleLogs = [];

function safeStringify(v) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

function captureConsole() {
  if (global.__co3ConsoleCaptured) return;
  global.__co3ConsoleCaptured = true;
  ['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
    try {
      const orig = console[level] && console[level].bind(console);
      console[level] = (...args) => {
        try {
          const line = args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
          consoleLogs.push(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${line}`);
          if (consoleLogs.length > CONSOLE_MAX) consoleLogs.shift();
        } catch {}
        if (orig) orig(...args);
      };
    } catch {}
  });
}
captureConsole();

export function consoleLogBuffer() {
  return consoleLogs.slice();
}

// ---- 拼装导出文本 ----
async function safe(fn, fallback) {
  try {
    const v = await fn();
    return v ?? fallback ?? '';
  } catch (e) {
    return `${fallback ?? ''} (err: ${String(e && e.message || e).slice(0, 200)})`;
  }
}

export async function buildDiagnosticText() {
  const parts = [];
  parts.push(`===== CO3 诊断导出 =====`);
  parts.push(`导出时间: ${new Date().toISOString()}`);
  parts.push(`平台: ${Platform.OS} ${Platform.Version}`);

  // 1. 原生侧（环境 + crash.log + 落盘 trace + 本会话缓冲）
  const native = await safe(
    () => NativeModules.CoDiag && NativeModules.CoDiag.exportNativeLogs(),
    '(原生导出不可用：CoDiag 模块未注册)',
  );
  parts.push(native);

  // 2. JS 配置
  parts.push(`\n===== JS 配置 =====`);
  parts.push(`DoH: ${await safe(() => getDoh(), '(none)')}`);
  parts.push(`自定义 IP: ${await safe(() => getCustomIPs(), '(dns)')}`);
  parts.push(`上次代理启动错误: ${await safe(() => getLastStartError(), '(无)')}`);
  parts.push(`remoteLog 统计: ${await safe(async () => JSON.stringify(remoteLogStats()), '(unavailable)')}`);

  // 3. ECH 状态
  parts.push(`\n===== ECH 状态 =====`);
  parts.push(await safe(() => getEchStatus(), 'unavailable'));
  parts.push(`CookieJar:\n${await safe(() => getJarInfo(), '(空)')}`);

  // 4. 快速自检：当场发一次 AO3 请求（短超时 8s），复现"加载作品失败"现场
  parts.push(`\n===== 快速自检（AO3 首页，8s 超时） =====`);
  const t0 = Date.now();
  try {
    const res = await ao3Text('https://archiveofourown.org/', { timeout: 8000 });
    parts.push(`成功: HTTP ${res && res.status ? res.status : '?'} ${Date.now() - t0}ms`);
  } catch (e) {
    parts.push(`失败 ${Date.now() - t0}ms: ${String(e && e.message || e).slice(0, 300)}`);
  }

  // 5. JS console（最近 400 条）
  const slice = consoleLogs.slice(-400);
  parts.push(`\n===== JS console（最近 ${slice.length} 条） =====`);
  parts.push(...slice);

  return parts.join('\n');
}

/**
 * 导出诊断日志。
 *   mode='share'（默认）：写文件拉起系统分享；豆包等不吃附件的接收端，
 *                        文字里也带 12KB 摘要。
 *   mode='copy'：完整日志直接复制到剪贴板，用户粘贴到任意对话发回。
 * 返回 'shared' / 'copied' / 'copy-failed' / 'unavailable'。
 */
export async function exportDiagnostics(mode = 'share') {
  const text = await buildDiagnosticText();
  const mod = NativeModules.CoDiag;
  if (!mod) return 'unavailable';
  if (mode === 'copy') {
    try {
      if (typeof mod.copyText === 'function') {
        await mod.copyText('CO3 诊断日志', text);
        return 'copied';
      }
    } catch {}
    return 'copy-failed';
  }
  let ok = false;
  try {
    if (mod && typeof mod.shareText === 'function') {
      ok = await mod.shareText('CO3 诊断日志', text);
    }
  } catch {}
  return ok === false ? 'copied' : 'shared';
}

export default exportDiagnostics;
