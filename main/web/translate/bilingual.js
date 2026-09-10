/**
 * 段落级双语对照（思想移植自 FluentRead full-page-translation：
 * 原文一段 + 译文一段跟在下面；本机只处理章节正文 HTML）。
 */
import { translateTexts } from './freeTranslation';
import { getTranslateEngine } from './settings';

// 本机推理超时兜底（仅防真死锁；正常慢不误杀）。超时即降级在线机翻。
const DEVICE_TIMEOUT_MS = 120000;

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || 'timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// deviceTranslate 依赖 NativeModules，用惰性 require 避免启动链加载 native 依赖
function getDeviceTranslate() {
  return require('./deviceTranslate').translateDevice;
}

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把章节 HTML 切成段落：[{html, text}]，纯空段跳过 */
export function splitParagraphs(chapterHtml) {
  const parts = chapterHtml.split(/<\/p\s*>/i);
  const out = [];
  for (const part of parts) {
    const html = part.includes('<') ? `${part}</p>` : part;
    const text = stripTags(part);
    if (text.length === 0) continue;
    // 超长段按换行再切，避免单次请求过大
    if (text.length > 1500) {
      for (const chunk of text.split('\n')) {
        const t = chunk.trim();
        if (t) out.push({ html: `<p>${escapeHtml(t)}</p>`, text: t });
      }
    } else {
      out.push({ html: html.trim(), text });
    }
  }
  return out;
}

/**
 * 文本数组翻译（供简介/标题/章节名复用同一引擎路由）。
 * 返回译文数组，与输入一一对应；本机失败自动降级在线。
 */
export async function translateTextsSmart(texts, fromLang = 'en', toLang = 'zh-CN') {
  if (texts.length === 0) return [];
  try {
    if ((await getTranslateEngine()) === 'device') {
      const out = await getDeviceTranslate()(texts);
      if (out && out.length === texts.length) return out;
    }
  } catch (e) {
    console.log(`本机翻译失败，切在线：${e.message}`);
  }
  return translateTexts(texts, fromLang, toLang);
}

/**
 * 双语 HTML：mode=bilingual 原文+译文对照；translated 仅译文。
 * 译文段带 class="co3-trans" 供主题 CSS 着色。
 */
export async function buildBilingualHtml(
  chapterHtml,
  mode = 'bilingual',
  fromLang = 'en',
  toLang = 'zh-CN',
  onProgress = null,
) {
  const paras = splitParagraphs(chapterHtml);
  if (paras.length === 0) return chapterHtml;
  const texts = paras.map(p => p.text);
  // 引擎路由：device(本机AI) 优先 → 失败/超时自动降级在线免费机翻
  let translations = null;
  if ((await getTranslateEngine()) === 'device') {
    try {
      // 先报 0/n：模型首次加载可能几十秒，让 UI 立即有反馈
      if (onProgress) onProgress(0, paras.length);
      // 本机推理慢，把 onProgress 透传下去让 UI 显示"第 x/n 段"
      translations = await withTimeout(
        getDeviceTranslate()(texts, onProgress),
        DEVICE_TIMEOUT_MS,
        '本机翻译超时',
      );
    } catch (e) {
      console.log(`本机翻译失败，切在线：${e.message}`);
      if (onProgress) onProgress(0, paras.length);
    }
  }
  if (!translations) {
    translations = await translateTexts(texts, fromLang, toLang);
    if (onProgress) onProgress(paras.length, paras.length);
  }
  return paras
    .map((p, i) => {
      const trans = `<p class="co3-trans">${escapeHtml(translations[i] || '')}</p>`;
      if (mode === 'translated') return trans;
      return `${p.html}${trans}`;
    })
    .join('\n');
}
