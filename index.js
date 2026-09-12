/**
 * @format
 *
 * ⚠️ 启动诊断入口 —— 别改回 `import app from './main/app'`：
 *
 * 真机现象（2026-09-12）：启动 0.42 秒 SIGABRT，崩溃栈只到
 * `RCTExceptionsManager.reportFatal` → `abort()`，没有任何 JS 错误信息。
 * 根因是「JS 致命错误 → ExceptionsManager 上报 → 原生 fatal handler → abort」，
 * 进程在日志发出去之前就死了。
 *
 * 所以这里做三件事：
 *   1) 先装零依赖的上报器（必须在加载 app 之前）；
 *   2) 接管全局错误处理器，**不把错误交回 ExceptionsManager**，进程就不会 abort；
 *   3) 错误原文 + 调用栈直接画在屏幕上，截图即可定位（同时也会上报）。
 */
import { AppRegistry, ScrollView, StyleSheet, Text } from 'react-native';
import React from 'react';
import { name as appName } from './app.json';
import { rlog, rlogError } from './main/utils/remoteLog';

rlog('bundle_entry_loaded');

let captured = null;
const listeners = new Set();

function capture(kind, e, extra) {
  if (!captured) {
    captured = { kind, err: e, extra: extra || {} };
  }
  try {
    rlogError('js_fatal_captured', e, { kind, ...(extra || {}) });
  } catch (_) {}
  try {
    console.warn('[trap]', kind, (e && e.message) || e);
  } catch (_) {}
  listeners.forEach((fn) => {
    try { fn(); } catch (_) {}
  });
}

// ---- 1) 接管全局错误处理器（异步错误也能兜住，且不触发原生 abort）----
try {
  const EU = global.ErrorUtils;
  if (EU && typeof EU.setGlobalHandler === 'function') {
    EU.setGlobalHandler((e, isFatal) => {
      capture('global_handler', e, { isFatal: !!isFatal });
      // 刻意不调回原处理器：原处理器会走 ExceptionsManager → 原生 fatal → abort
    });
    rlog('error_utils_hooked');
  } else {
    rlog('error_utils_missing');
  }
} catch (e) {
  console.warn('[trap] ErrorUtils 接管失败', e && e.message);
}

// ---- 2) 惰性加载 app，模块求值阶段的错误也要抓住 ----
let App = null;
let requireError = null;
try {
  // eslint-disable-next-line global-require
  App = require('./main/app').default;
} catch (e) {
  requireError = e;
  capture('require_main_app', e);
}

function TrapScreen({ err }) {
  const message = String((err && err.message) || err || 'unknown');
  const stack = String((err && err.stack) || '').slice(0, 2000);
  return React.createElement(
    ScrollView,
    { contentContainerStyle: styles.wrap },
    React.createElement(Text, { style: styles.title }, '启动失败（诊断版）'),
    React.createElement(
      Text,
      { style: styles.hint },
      '这一屏的信息已自动上报，直接截图发给开发者即可。',
    ),
    React.createElement(Text, { style: styles.error }, message),
    React.createElement(Text, { style: styles.stack }, stack),
  );
}

function Root() {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  if (captured) return React.createElement(TrapScreen, { err: captured.err });
  if (!App) return React.createElement(TrapScreen, { err: requireError || new Error('app 未加载') });
  return React.createElement(App);
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 64, backgroundColor: '#fff' },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 8, color: '#111' },
  hint: { fontSize: 13, color: '#666', marginBottom: 14, lineHeight: 19 },
  error: { fontSize: 13, color: '#b00', marginBottom: 12, lineHeight: 19 },
  stack: { fontSize: 11, color: '#777', lineHeight: 16 },
});

if (!App) {
  rlog('startup_fallback_screen_shown');
}

AppRegistry.registerComponent(appName, () => Root);
