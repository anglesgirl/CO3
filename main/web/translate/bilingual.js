/**
 * 段落级双语对照（思想移植自 FluentRead full-page-translation：
 * 原文一段 + 译文一段跟在下面；本机只处理章节正文 HTML）。
 */
import { translateTexts } from './freeTranslation';

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
  const translations = await translateTexts(
    paras.map(p => p.text),
    fromLang,
    toLang,
  );
  if (onProgress) onProgress(paras.length, paras.length);
  return paras
    .map((p, i) => {
      const trans = `<p class="co3-trans">${escapeHtml(translations[i] || '')}</p>`;
      if (mode === 'translated') return trans;
      return `${p.html}${trans}`;
    })
    .join('\n');
}
