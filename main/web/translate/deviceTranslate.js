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

/** 本机批量翻译（段落数组→译文数组），失败抛错由上层降级。 */
export async function translateDevice(texts) {
  await ensureInit();
  const { Hymt } = NativeModules;
  const out = [];
  for (const t of texts) {
    if (!t.trim()) {
      out.push('');
      continue;
    }
    const zh = await Hymt.translate(t, 512);
    out.push(String(zh || '').trim());
  }
  return out;
}
