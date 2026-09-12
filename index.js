/**
 * @format
 *
 * ⚠️ 这里的写法是为了「启动即崩」能被诊断，别改回静态 import：
 *
 * ES import 是提升的，`./main/app` 一旦在**模块求值阶段**抛错（原生模块没注册、
 * 循环依赖拿到 undefined 后立即使用……），整包会在 AppRegistry 注册之前就 abort，
 * 我们拿不到任何日志。
 *
 * 2026-09-12 iOS 真机实测到的现象：启动 0.42 秒后 SIGABRT，
 * 崩溃栈只到 `RCTExceptionsManager.reportFatal` → `abort()`，
 * 没有任何 JS 错误信息。所以：
 *   1) 先装零依赖的上报器（remoteLog 会顺带接管全局错误）；
 *   2) 再用 require() **惰性**加载 app，抛错也能被 try/catch 抓住；
 *   3) 抓到的错误既上报到日志服务，也**直接显示在屏幕上** —— 用户截个图就能定位。
 */
import { AppRegistry, ScrollView, StyleSheet, Text } from 'react-native';
import React from 'react';
import { name as appName } from './app.json';
import { rlog, rlogError } from './main/utils/remoteLog';

rlog('bundle_entry_loaded');

let startupError = null;
let App = null;

try {
  // eslint-disable-next-line global-require
  App = require('./main/app').default;
} catch (e) {
  startupError = e;
  rlogError('bundle_eval_failed', e, { phase: 'require_main_app' });
  console.warn('[startup] require(./main/app) 失败：', e && e.message);
}

function StartupFailure() {
  const message = String((startupError && startupError.message) || startupError || 'unknown');
  const stack = String((startupError && startupError.stack) || '').slice(0, 1800);
  return React.createElement(
    ScrollView,
    { contentContainerStyle: styles.wrap },
    React.createElement(Text, { style: styles.title }, '启动失败'),
    React.createElement(
      Text,
      { style: styles.hint },
      '这一屏的信息已经自动上报；直接截图发给开发者即可定位。',
    ),
    React.createElement(Text, { style: styles.error }, message),
    React.createElement(Text, { style: styles.stack }, stack),
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 64, backgroundColor: '#fff' },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 8, color: '#111' },
  hint: { fontSize: 13, color: '#666', marginBottom: 14, lineHeight: 19 },
  error: { fontSize: 13, color: '#b00', marginBottom: 12, lineHeight: 19 },
  stack: { fontSize: 11, color: '#777', lineHeight: 16 },
});

const Root = App || StartupFailure;
if (!App) {
  rlog('startup_fallback_screen_shown');
}

AppRegistry.registerComponent(appName, () => Root);
