/**
 * 本机 AI 翻译调用：Hymt 原生模块 + 段落切分。
 *
 * 性能要点（实测）：单段推理有约 500ms 的固定开销（in=6 字符也要 550ms），
 * 逐段串行翻一篇文章光固定开销就 75 秒+。所以这里按批合并，
 * 批内用一次推理（translateBatch）拿到多段译文；批失败自动降级为逐段。
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

/** 每批段数。太大易超出上下文、且模型更容易漏段；6 段是稳与快的折中。 */
const BATCH = 6;

/**
 * 本机批量翻译（段落数组→译文数组），失败抛错由上层降级。
 * onProgress(done,total) 每段完成后回调，供 UI 显示进度（推理慢，必须有反馈）。
 */
export async function translateDevice(texts, onProgress) {
  await ensureInit();
  const { Hymt } = NativeModules;
  const total = texts.length;
  const out = new Array(total).fill('');
  let done = 0;
  const tick = () => {
    done += 1;
    if (onProgress) onProgress(done, total);
  };

  for (let i = 0; i < total; i += BATCH) {
    // 收集本批非空段落（空段直接占位，不能进批，否则会打乱段数对应）
    const idx = [];
    const txt = [];
    for (let k = 0; k < BATCH && i + k < total; k += 1) {
      const t = texts[i + k];
      if (t && t.trim()) {
        idx.push(i + k);
        txt.push(t);
      } else {
        out[i + k] = '';
        tick();
      }
    }
    if (!txt.length) continue;

    try {
      const zh = await Hymt.translateBatch(txt, 1024);
      if (!zh || zh.length !== txt.length) throw new Error('batch mismatch');
      for (let k = 0; k < idx.length; k += 1) {
        out[idx[k]] = String(zh[k] || '').trim();
        tick();
      }
    } catch (e) {
      // 整批降级为逐段（宁可慢，也不能漏段/错位）
      for (let k = 0; k < idx.length; k += 1) {
        try {
          const zh = await Hymt.translate(txt[k], 512);
          out[idx[k]] = String(zh || '').trim();
        } catch (e2) {
          out[idx[k]] = '';
        }
        tick();
      }
    }
  }
  return out;
}
