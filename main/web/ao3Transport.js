import ky from 'ky';
import { Platform } from 'react-native';
import { diagEvent } from '../utils/diag';

/**
 * AO3 唯一业务传输门面。
 *
 * 业务层禁止直接使用 fetch/ky/WebView；所有 AO3 请求先经过这里。
 * Android 底层由 React Native OkHttp 工厂统一接入 Conscrypt ECH；
 * iOS 底层由 echKy 统一接入 Go ECH 代理。
 *
 * 当前阶段：GET/POST 都先走同一个 ECH 网络客户端；H3 仍由 WebView
 * 静态资源拦截器单独使用，待统一响应模型完成后再切成 H3 主路。
 */
const nativeKy = Platform.OS === 'ios'
  ? require('./echKy').default
  : ky.create({ timeout: 30000 });

const AO3_HOSTS = new Set([
  'archiveofourown.org',
  'www.archiveofourown.org',
]);

export function isAo3Url(url) {
  try {
    return AO3_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function assertAo3(url) {
  if (!isAo3Url(url)) {
    throw new Error(`AO3Transport 拒绝非 AO3 地址: ${String(url).slice(0, 120)}`);
  }
}

export async function ao3Request(url, options = {}) {
  assertAo3(url);
  const method = String(options.method || 'GET').toUpperCase();
  diagEvent('ao3_transport_begin', {
    method,
    url: String(url).slice(0, 100),
    channel: 'unified-ech',
  });
  try {
    const response = await nativeKy(url, {
      ...options,
      method,
      // 禁止 ky 自己重试：一次业务请求只发一次，失败由统一传输层明确处理。
      retry: 0,
    });
    diagEvent('ao3_transport_ok', {
      method,
      url: String(url).slice(0, 100),
      status: String(response.status),
      channel: 'unified-ech',
    });
    return response;
  } catch (error) {
    diagEvent('ao3_transport_fail', {
      method,
      url: String(url).slice(0, 100),
      error: String(error?.message || error).slice(0, 160),
      channel: 'unified-ech',
    });
    throw error;
  }
}

export async function ao3Text(url, options = {}) {
  return ao3Request(url, options).then(response => response.text());
}

export default ao3Request;
