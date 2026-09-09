/**
 * 免费翻译降级链（移植自 FluentRead freeTranslation.ts + free-translation.ts 思想）。
 * 顺序：谷歌 → 微软 → MyMemory，前一个抛错就换下一个。
 * 注意：这些请求走系统网络（非 ECH），Google 在墙内直连可能失败，
 * 会自动降级到下一个引擎。
 */
import {
  translateGoogle,
  translateMicrosoft,
  translateMicrosoftBatch,
  translateMyMemory,
} from './providers';

const ORDER = ['google', 'microsoft', 'myMemory'];

async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function translateOne(engine, text, fromLang, toLang) {
  switch (engine) {
    case 'google':
      return translateGoogle(text, fromLang, toLang);
    case 'microsoft':
      return translateMicrosoft(text, fromLang, toLang);
    case 'myMemory':
      return translateMyMemory(text, fromLang, toLang);
    default:
      throw new Error(`未知翻译引擎：${engine}`);
  }
}

/** 单段翻译：按顺序逐个引擎试，全部失败才抛错 */
export async function translateText(text, fromLang = 'en', toLang = 'zh-CN') {
  let lastError = null;
  for (const engine of ORDER) {
    try {
      return await translateOne(engine, text, fromLang, toLang);
    } catch (e) {
      lastError = e;
      console.log(`翻译引擎 ${engine} 失败，换下一个：${e.message}`);
    }
  }
  throw lastError || new Error('全部翻译引擎失败');
}

/** 多段翻译：微软走批量，其他并发 3 路，每段独立降级 */
export async function translateTexts(texts, fromLang = 'en', toLang = 'zh-CN') {
  if (texts.length === 0) return [];
  // 先试微软批量，一次搞定
  try {
    return await translateMicrosoftBatch(texts, fromLang, toLang);
  } catch (e) {
    console.log(`微软批量失败，切逐段降级：${e.message}`);
  }
  return withConcurrency(texts, 3, t => translateText(t, fromLang, toLang));
}
