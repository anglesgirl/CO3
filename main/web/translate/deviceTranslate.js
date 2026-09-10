/**
 * 本机 AI 翻译调用：Hymt 原生模块 + 段落切分。失败抛错，上层自动降级在线引擎。
 */
import { NativeModules } from 'react-native';

let initDone = false;

async function ensureInit() {
  const { Hymt } = NativeModules;
  if (!Hymt) throw new Error('本机模块不可用');
  if (initDone && (await Hymt.isReady())) return;
  const ok = await Hymt.init();
  if (!ok) throw new Error('模型加载失败');
  initDone = true;
}

export async function deviceReady() {
  try {
    const { Hymt } = NativeModules;
    if (!Hymt) return false;
    return await Hymt.isReady();
  } catch {
    return false;
  }
}

/**
 * 本机批量翻译（段落数组→译文数组），失败抛错由上层降级。
 * onProgress(done,total) 每段完成后回调，供 UI 显示进度（推理慢，必须有反馈）。
 */
export async function translateDevice(texts, onProgress) {
  await ensureInit();
  const { Hymt } = NativeModules;
  const out = [];
  const total = texts.length;
  for (let i = 0; i < total; i += 1) {
    const t = texts[i];
    if (!t || !t.trim()) {
      out.push('');
      if (onProgress) onProgress(i + 1, total);
      continue;
    }
    const zh = await Hymt.translate(t, 512);
    out.push(String(zh || '').trim());
    if (onProgress) onProgress(i + 1, total);
  }
  return out;
}
