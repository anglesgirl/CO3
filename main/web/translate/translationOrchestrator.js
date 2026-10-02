/**
 * TranslationOrchestrator - 翻译编排层（2026-10-02）
 *
 * 借鉴：
 * - ao3-chinese：术语占位符、三段式 prompt、二分重试
 * - 沉浸式翻译：AO3 专家提示词、YAML 带 id 批量协议、每批 4 段
 *
 * 架构：原生（HyMT）只提供推理接口，所有编排逻辑在 JS 侧。
 * 引擎可替换：本机 HyMT / 在线兜底。
 */

import { NativeModules } from 'react-native';

// ---------------------------------------------------------------------------
// 术语表（借鉴 ao3-chinese 的占位符机制 + 沉浸式翻译的按段注入）
// ---------------------------------------------------------------------------

// 内置同人圈常用术语（可扩展）
const BUILTIN_TERMS = {
  // 咒术回战
  'Sukuna': '宿傩',
  'Itadori Yuji': '虎杖悠仁',
  'Yuji Itadori': '虎杖悠仁',
  'Megumi Fushiguro': '伏黑惠',
  'Nobara Kugisaki': '钉崎野蔷薇',
  'Satoru Gojo': '五条悟',
  'Kenjaku': '羂索',
  // 通用同人术语
  'slow burn': '慢热',
  'slow-burn': '慢热',
};

class TermManager {
  constructor(customTerms = {}) {
    this.terms = { ...BUILTIN_TERMS, ...customTerms };
    // 按长度降序，避免短词先匹配（如 "Sukuna" vs "Sukuna x Reader"）
    this.sortedKeys = Object.keys(this.terms).sort((a, b) => b.length - a.length);
  }

  /**
   * 只处理本段实际出现的术语（抄沉浸式翻译：省 token）
   * 返回 { text: 占位符替换后的文本, mapping: {placeholder: 中文} }
   */
  applyPlaceholders(text) {
    const mapping = {};
    let idx = 0;
    let result = text;
    for (const key of this.sortedKeys) {
      if (result.includes(key)) {
        const ph = `__PH_${idx++}__`;
        // 全局替换（转义正则特殊字符）
        const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(esc, 'g'), ph);
        mapping[ph] = this.terms[key];
      }
    }
    return { text: result, mapping };
  }

  /** 还原占位符（模糊匹配：模型可能轻微改写格式） */
  restorePlaceholders(translated, mapping) {
    let result = translated;
    for (const [ph, zh] of Object.entries(mapping)) {
      // 精确匹配
      if (result.includes(ph)) {
        result = result.split(ph).join(zh);
        continue;
      }
      // 模糊匹配：去掉下划线后找
      const loose = ph.replace(/_/g, '');
      const re = new RegExp(loose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      result = result.replace(re, zh);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// 提示词构建（借鉴 ao3-chinese 三段式 + 沉浸式翻译 AO3 专家）
// ---------------------------------------------------------------------------

function buildPrompt(textsWithIds) {
  // textsWithIds: [{id, text}]
  const items = textsWithIds.map(({ id, text }) => `- id: ${id}\n  text: "${text}"`).join('\n');
  return `You are a professional translator specializing in Chinese web novels and fanfiction (同人小说).

Translate the following paragraphs from English to Chinese.

Rules (AO3 fanfiction specific):
- Use natural, fluent 同人文 style; dialogue should be colloquial
- Character names: use established Chinese fandom translations; keep consistent
- Relationship tags and fandom tropes: use established Chinese fandom terms (e.g. slow-burn → 慢热), do NOT translate literally
- Preserve the narrative voice, tone, and cultural nuances
- Output MUST have the same number of paragraphs as input, in the same order
- Output ONLY the translations, one per line, in this exact format:
  id: <translation>
- Do NOT add explanations, notes, or extra text

Paragraphs:
${items}`;
}

function parseBatchResponse(response, expectedIds) {
  // 解析 "id: translation" 格式
  const lines = response.split('\n');
  const result = {};
  for (const line of lines) {
    const m = line.match(/^(\S+):\s*(.*)$/);
    if (m && expectedIds.includes(m[1])) {
      result[m[1]] = m[2].trim();
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 编排器
// ---------------------------------------------------------------------------

const BATCH_SIZE = 4; // 抄沉浸式翻译
const MAX_RETRY_DEPTH = 4; // 抄 ao3-chinese 二分下探

export class TranslationOrchestrator {
  constructor(options = {}) {
    this.termManager = new TermManager(options.customTerms);
    this.engine = options.engine || 'device'; // 'device' | 'online'
    this.onProgress = options.onProgress || null;
  }

  async translateParagraphs(paragraphs) {
    // paragraphs: [{id, text}]
    // 返回: {id: translatedText}
    const results = {};
    // 分批
    for (let i = 0; i < paragraphs.length; i += BATCH_SIZE) {
      const batch = paragraphs.slice(i, i + BATCH_SIZE);
      const batchResult = await this.translateBatchWithRetry(batch, 0);
      Object.assign(results, batchResult);
      if (this.onProgress) {
        this.onProgress(Math.min(i + BATCH_SIZE, paragraphs.length), paragraphs.length);
      }
    }
    return results;
  }

  async translateBatchWithRetry(batch, depth) {
    // 1. 术语占位符
    const withPlaceholders = batch.map(({ id, text }) => {
      const { text: phText, mapping } = this.termManager.applyPlaceholders(text);
      return { id, text: phText, mapping, original: text };
    });

    // 2. 构建提示词
    const prompt = buildPrompt(withPlaceholders.map(({ id, text }) => ({ id, text })));
    const maxTokens = Math.max(512, Math.min(4096,
      withPlaceholders.reduce((s, p) => s + p.text.length, 0) * 2));

    // 3. 调用引擎
    let raw = '';
    try {
      if (this.engine === 'device') {
        const { Hymt } = NativeModules;
        raw = await Hymt.translateWithPrompt(prompt, maxTokens);
      } else {
        const { translateTexts } = require('./freeTranslation');
        const texts = withPlaceholders.map(p => p.original);
        const out = await translateTexts(texts, 'en', 'zh-CN');
        // 在线引擎：逐段返回，直接组装
        const res = {};
        withPlaceholders.forEach((p, idx) => {
          res[p.id] = out[idx] || '';
        });
        return this.restoreAndValidate(res, withPlaceholders);
      }
    } catch (e) {
      raw = '';
    }

    // 4. 解析
    const expectedIds = withPlaceholders.map(p => String(p.id));
    const parsed = parseBatchResponse(String(raw || ''), expectedIds);

    // 5. 校验段数
    const missing = expectedIds.filter(id => !parsed[id] || !parsed[id].trim());
    if (missing.length === 0) {
      return this.restoreAndValidate(parsed, withPlaceholders);
    }

    // 6. 二分下探重试（抄 ao3-chinese）
    if (depth >= MAX_RETRY_DEPTH || batch.length <= 1) {
      // 实在不行，返回已成功的，缺失的留空
      const partial = this.restoreAndValidate(parsed, withPlaceholders);
      missing.forEach(id => { partial[id] = ''; });
      return partial;
    }
    const mid = Math.ceil(batch.length / 2);
    const left = await this.translateBatchWithRetry(batch.slice(0, mid), depth + 1);
    const right = await this.translateBatchWithRetry(batch.slice(mid), depth + 1);
    return { ...left, ...right };
  }

  restoreAndValidate(parsed, withPlaceholders) {
    const result = {};
    const byId = Object.fromEntries(withPlaceholders.map(p => [String(p.id), p]));
    for (const [id, trans] of Object.entries(parsed)) {
      const p = byId[id];
      if (p) {
        result[id] = this.termManager.restorePlaceholders(trans, p.mapping);
      }
    }
    return result;
  }
}

export default TranslationOrchestrator;
