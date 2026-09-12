#!/usr/bin/env node
/**
 * AsyncStorage 启动闪退修复（postinstall 自动打补丁，幂等，零依赖）。
 *
 * 背景：@react-native-async-storage/async-storage 在模块求值期就解析
 * TurboModule；新架构下 bundle 求值期 TurboModule 可能还没就绪，解析得
 * null 后 AsyncStorage.native 顶层直接抛 "AsyncStorage is null" → 启动 abort
 *（2026-09-09 的 409401c 修过同类，2026-09-12 在 Redmi Android 16 上复发）。
 * 本补丁把解析推迟到首次调用（调用一定发生在挂载之后，那时必定就绪），
 * 求值期只建一个 Proxy，不碰任何原生模块。
 *
 * 三个构建输出都要打：
 *   src/*.ts        —— Metro 经 package.json 的 react-native 字段用它（真机崩溃走这里）
 *   lib/commonjs/*  —— jest 经 main 字段用它
 *   lib/module/*    —— webpack 经 module 字段用它
 *
 * 精确匹配、打不上就让安装失败（fail-closed：CI 变红，而不是静默发无补丁包）。
 */
const fs = require("fs");
const path = require("path");

const MARKER = "resolveRealStorage";
const PKG = path.join(
  __dirname, "..", "node_modules",
  "@react-native-async-storage", "async-storage"
);

// ---------- src/RCTAsyncStorage.ts（Metro 真机链路）----------
const TS_OLD = `let RCTAsyncStorage = TurboModuleRegistry
  ? TurboModuleRegistry.get("PlatformLocalStorage") || // Support for external modules, like react-native-windows
    TurboModuleRegistry.get("RNC_AsyncSQLiteDBStorage") ||
    TurboModuleRegistry.get("RNCAsyncStorage")
  : NativeModules["PlatformLocalStorage"] || // Support for external modules, like react-native-windows
    NativeModules["RNC_AsyncSQLiteDBStorage"] ||
    NativeModules["RNCAsyncStorage"];

if (!RCTAsyncStorage && shouldFallbackToLegacyNativeModule()) {
  if (TurboModuleRegistry) {
    RCTAsyncStorage =
      TurboModuleRegistry.get("AsyncSQLiteDBStorage") ||
      TurboModuleRegistry.get("AsyncLocalStorage");
  } else {
    RCTAsyncStorage =
      NativeModules["AsyncSQLiteDBStorage"] ||
      NativeModules["AsyncLocalStorage"];
  }
}

export default RCTAsyncStorage;`;

const TS_NEW = `function resolveRealStorage() {
  let mod =
    TurboModuleRegistry
      ? TurboModuleRegistry.get("PlatformLocalStorage") || // Support for external modules, like react-native-windows
        TurboModuleRegistry.get("RNC_AsyncSQLiteDBStorage") ||
        TurboModuleRegistry.get("RNCAsyncStorage")
      : NativeModules["PlatformLocalStorage"] || // Support for external modules, like react-native-windows
        NativeModules["RNC_AsyncSQLiteDBStorage"] ||
        NativeModules["RNCAsyncStorage"];

  if (!mod && shouldFallbackToLegacyNativeModule()) {
    if (TurboModuleRegistry) {
      mod =
        TurboModuleRegistry.get("AsyncSQLiteDBStorage") ||
        TurboModuleRegistry.get("AsyncLocalStorage");
    } else {
      mod =
        NativeModules["AsyncSQLiteDBStorage"] ||
        NativeModules["AsyncLocalStorage"];
    }
  }
  return mod;
}

// [小雅co3] 延迟绑定：求值期只建 Proxy，不碰原生模块；首次调用（必在挂载后）
// 才真正解析。那时 TurboModule 已就绪，不再抛启动期 is null。
const lazyStorage = new Proxy({} as object, {
  get(_target, prop: string | symbol) {
    const real = resolveRealStorage() as any;
    if (!real) {
      throw new Error(
        "[@RNC/AsyncStorage]: NativeModule: AsyncStorage is null."
      );
    }
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export default lazyStorage;`;

// ---------- lib/commonjs/RCTAsyncStorage.js（jest 链路）----------
const CJS_OLD = `let RCTAsyncStorage = _reactNative.TurboModuleRegistry ? _reactNative.TurboModuleRegistry.get("PlatformLocalStorage") ||
// Support for external modules, like react-native-windows
_reactNative.TurboModuleRegistry.get("RNC_AsyncSQLiteDBStorage") || _reactNative.TurboModuleRegistry.get("RNCAsyncStorage") : _reactNative.NativeModules["PlatformLocalStorage"] ||
// Support for external modules, like react-native-windows
_reactNative.NativeModules["RNC_AsyncSQLiteDBStorage"] || _reactNative.NativeModules["RNCAsyncStorage"];
if (!RCTAsyncStorage && (0, _shouldFallbackToLegacyNativeModule.shouldFallbackToLegacyNativeModule)()) {
  if (_reactNative.TurboModuleRegistry) {
    RCTAsyncStorage = _reactNative.TurboModuleRegistry.get("AsyncSQLiteDBStorage") || _reactNative.TurboModuleRegistry.get("AsyncLocalStorage");
  } else {
    RCTAsyncStorage = _reactNative.NativeModules["AsyncSQLiteDBStorage"] || _reactNative.NativeModules["AsyncLocalStorage"];
  }
}
var _default = exports.default = RCTAsyncStorage;`;

const CJS_NEW = `function resolveRealStorage() {
  let mod = _reactNative.TurboModuleRegistry ? _reactNative.TurboModuleRegistry.get("PlatformLocalStorage") ||
// Support for external modules, like react-native-windows
_reactNative.TurboModuleRegistry.get("RNC_AsyncSQLiteDBStorage") || _reactNative.TurboModuleRegistry.get("RNCAsyncStorage") : _reactNative.NativeModules["PlatformLocalStorage"] ||
// Support for external modules, like react-native-windows
_reactNative.NativeModules["RNC_AsyncSQLiteDBStorage"] || _reactNative.NativeModules["RNCAsyncStorage"];
  if (!mod && (0, _shouldFallbackToLegacyNativeModule.shouldFallbackToLegacyNativeModule)()) {
    if (_reactNative.TurboModuleRegistry) {
      mod = _reactNative.TurboModuleRegistry.get("AsyncSQLiteDBStorage") || _reactNative.TurboModuleRegistry.get("AsyncLocalStorage");
    } else {
      mod = _reactNative.NativeModules["AsyncSQLiteDBStorage"] || _reactNative.NativeModules["AsyncLocalStorage"];
    }
  }
  return mod;
}
// [小雅co3] 延迟绑定：求值期只建 Proxy，不碰原生模块；首次调用（必在挂载后）
// 才真正解析。那时 TurboModule 已就绪，不再抛启动期 is null。
var _default = exports.default = new Proxy({}, {
  get: function (_target, prop) {
    var real = resolveRealStorage();
    if (!real) {
      throw new Error("[@RNC/AsyncStorage]: NativeModule: AsyncStorage is null.");
    }
    var value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  }
});`;

// ---------- lib/module/RCTAsyncStorage.js（webpack 链路）----------
const ESM_OLD = `let RCTAsyncStorage = TurboModuleRegistry ? TurboModuleRegistry.get("PlatformLocalStorage") ||
// Support for external modules, like react-native-windows
TurboModuleRegistry.get("RNC_AsyncSQLiteDBStorage") || TurboModuleRegistry.get("RNCAsyncStorage") : NativeModules["PlatformLocalStorage"] ||
// Support for external modules, like react-native-windows
NativeModules["RNC_AsyncSQLiteDBStorage"] || NativeModules["RNCAsyncStorage"];
if (!RCTAsyncStorage && shouldFallbackToLegacyNativeModule()) {
  if (TurboModuleRegistry) {
    RCTAsyncStorage = TurboModuleRegistry.get("AsyncSQLiteDBStorage") || TurboModuleRegistry.get("AsyncLocalStorage");
  } else {
    RCTAsyncStorage = NativeModules["AsyncSQLiteDBStorage"] || NativeModules["AsyncLocalStorage"];
  }
}
export default RCTAsyncStorage;`;

const ESM_NEW = `function resolveRealStorage() {
  let mod = TurboModuleRegistry ? TurboModuleRegistry.get("PlatformLocalStorage") ||
// Support for external modules, like react-native-windows
TurboModuleRegistry.get("RNC_AsyncSQLiteDBStorage") || TurboModuleRegistry.get("RNCAsyncStorage") : NativeModules["PlatformLocalStorage"] ||
// Support for external modules, like react-native-windows
NativeModules["RNC_AsyncSQLiteDBStorage"] || NativeModules["RNCAsyncStorage"];
  if (!mod && shouldFallbackToLegacyNativeModule()) {
    if (TurboModuleRegistry) {
      mod = TurboModuleRegistry.get("AsyncSQLiteDBStorage") || TurboModuleRegistry.get("AsyncLocalStorage");
    } else {
      mod = NativeModules["AsyncSQLiteDBStorage"] || NativeModules["AsyncLocalStorage"];
    }
  }
  return mod;
}
// [小雅co3] 延迟绑定：求值期只建 Proxy，不碰原生模块；首次调用（必在挂载后）
// 才真正解析。那时 TurboModule 已就绪，不再抛启动期 is null。
const lazyStorage = new Proxy({}, {
  get: function (_target, prop) {
    const real = resolveRealStorage();
    if (!real) {
      throw new Error("[@RNC/AsyncStorage]: NativeModule: AsyncStorage is null.");
    }
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  }
});
export default lazyStorage;`;

const TARGETS = [
  ["src/RCTAsyncStorage.ts", TS_OLD, TS_NEW],
  ["lib/commonjs/RCTAsyncStorage.js", CJS_OLD, CJS_NEW],
  ["lib/module/RCTAsyncStorage.js", ESM_OLD, ESM_NEW],
];

if (!fs.existsSync(PKG)) {
  console.log("[asyncstorage-lazy] 包不存在，跳过（不影响安装）");
  process.exit(0);
}

let patched = 0;
const failed = [];
for (const [rel, oldText, newText] of TARGETS) {
  const file = path.join(PKG, rel);
  if (!fs.existsSync(file)) {
    console.log(`[asyncstorage-lazy] 缺 ${rel}，跳过`);
    continue;
  }
  const content = fs.readFileSync(file, "utf8");
  if (content.includes(MARKER)) {
    console.log(`[asyncstorage-lazy] ${rel} 已打过，跳过`);
    patched++;
    continue;
  }
  if (!content.includes(oldText)) {
    failed.push(rel);
    continue;
  }
  fs.writeFileSync(file, content.replace(oldText, newText));
  console.log(`[asyncstorage-lazy] ${rel} 已打补丁`);
  patched++;
}

if (failed.length > 0) {
  console.error(
    `[asyncstorage-lazy] 文本不匹配（上游可能升级了），拒绝静默跳过：${failed.join(", ")}`
  );
  process.exit(1);
}
console.log(`[asyncstorage-lazy] 完成（${patched} 个文件）`);
