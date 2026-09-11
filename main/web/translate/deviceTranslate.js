/**
 * 本机 AI 翻译调用：质量可控的翻译流程。
 *
 * 设计要点（为什么要重做）：
 *  - 本机模型是 HyMT 1.8B 2bit 量化，稳定性有限，实测会产出三类坏结果：
 *      ① 中途截断（原文没说完就停）② 混入其它语言/乱码 ③ 吐重复垃圾（*** 串）
 *  - 官方引擎的停止条件是"空串即结束"（反编译 InferenceEngineImpl 证实），
 *    所以坏结果只能在上层识别与补救，不能靠改停止条件。
 *  - 因此这里改为：批量求快 → 逐段质量校验 → 坏段降级单段重试 → 仍坏则留空。
 *    留空是刻意的 fail-closed：宁可这段不译（用户看到原文），也绝不显示垃圾译文。
 */
import { NativeModules } from 'react-native';
import { diagEvent } from '../../utils/diag';

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

/** 每批段数。太大易超上下文且更容易漏段/串味；6 段是稳与快的折中。 */
const BATCH = 6;

/** 坏译文重试次数（每次用单段、更小的 maxTokens，减少跑偏）。 */
const RETRY = 2;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 允许出现的字符：中日韩、全角标点、ASCII 字母数字与常见标点、空白。 */
const ALLOWED = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef\u3400-\u4dbfa-zA-Z0-9\s.,!?;:'"()[\]{}\-–—…、。，！？；：""''（）《》〈〉·]/;

/**
 * 判断一段译文是否"不可信"。true = 应重试或丢弃。
 * 这些规则都来自真机上实际观察到的坏输出形态，不是凭空设想的。
 */
export function looksBrokenZh(zh, src) {
  const t = String(zh == null ? '' : zh).trim();
  if (!t) return true;

  // ① 非法字符超标：混入泰米尔文/西里尔/控制字符等（真机截图里出现过整段泰米尔文）
  let bad = 0;
  for (const ch of t) {
    if (!ALLOWED.test(ch)) bad += 1;
  }
  if (bad / t.length > 0.12) return true;

  // ② 原文不是中文、译文里也没有任何中文 → 模型没在翻译
  if (!CJK.test(t) && !CJK.test(String(src || ''))) {
    if (t.split(/\s+/).filter(Boolean).length > 12) return true;
  }

  // ③ 重复垃圾：连续 3 个以上星号/井号（真机出现过一大串 "* * *"）
  if (/[*#]{3,}/.test(t)) return true;

  // ④ 连续重复片段：同一 4~20 字片段重复 3 次以上（模型退化时的典型症状）
  if (/(.{4,20}?)\1{2,}/.test(t)) return true;

  // ⑤ 截断：原文以句末标点收尾，译文却没有，且译文明显偏短
  const srcEnds = /[.!?"'”’)\]]\s*$/.test(String(src || '').trim());
  const zhEnds = /[。！？…”’"')）】》\]]\s*$/.test(t);
  if (srcEnds && !zhEnds && t.length < 10) return true;

  return false;
}

/**
 * 翻译单段，带质量校验与重试。
 * 返回可信译文；始终不可信则返回 ''（调用方保留原文）。
 */
async function translateOneVerified(Hymt, text) {
  const maxTok = Math.max(192, Math.min(1024, text.length * 3));
  for (let attempt = 0; attempt <= RETRY; attempt += 1) {
    let zh = '';
    try {
      // 首次用批量接口（内部走同一条生成路径），重试改用单段接口
      zh = attempt === 0
        ? String((await Hymt.translateBatch([text], maxTok))?.[0] || '')
        : String((await Hymt.translate(text, maxTok)) || '');
    } catch (e) {
      zh = '';
    }
    if (!looksBrokenZh(zh, text)) {
      return zh.trim();
    }
    diagEvent('hymt_quality', {
      attempt: attempt,
      in_len: text.length,
      out_len: String(zh || '').length,
      out_tail: String(zh || '').slice(-30),
    });
  }
  return '';
}

/**
 * 本机批量翻译（段落数组→译文数组）。
 * onProgress(done,total) 每段完成回调；坏段经重试仍不可信则留空（不显示垃圾）。
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

    let batchZh = null;
    try {
      const zh = await Hymt.translateBatch(txt, 1024);
      if (zh && zh.length === txt.length) batchZh = zh;
    } catch (e) {
      batchZh = null;
    }

    for (let k = 0; k < idx.length; k += 1) {
      const src = txt[k];
      const cand = batchZh ? String(batchZh[k] || '').trim() : '';
      if (cand && !looksBrokenZh(cand, src)) {
        // 批量结果可信 → 直接采用（快路径）
        out[idx[k]] = cand;
      } else {
        // 批量结果不可信（或缺段）→ 单段重试；仍不可信则留空，保留原文
        if (cand) {
          diagEvent('hymt_quality', {
            attempt: -1,
            in_len: src.length,
            out_len: cand.length,
            out_tail: cand.slice(-30),
          });
        }
        out[idx[k]] = await translateOneVerified(Hymt, src);
      }
      tick();
    }
  }
  return out;
}
