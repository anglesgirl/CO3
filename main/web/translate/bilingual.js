/**
 * 段落级双语对照（思想移植自 FluentRead full-page-translation：
 * 原文一段 + 译文一段跟在下面；本机只处理章节正文 HTML）。
 *
 * 引擎优先级：device(本机HyMT) > ai(在线大模型) > free(机翻)。
 * 上层在 fetchChapterWithTheme 里根据 buildBilingualHtml 的 onProgress
 * 实时刷新"正在翻译 第i/n段"提示，避免长翻译时界面疑似卡死。
 */
import { translateTexts } from './freeTranslation';
import { getTranslateEngine } from './settings';

// deviceTranslate / aiProvider 用惰性 require，避免在 bundle 顶层加载
// (它们 import NativeModules / RNFS，若走顶层会把 TurboModule 引用带上启动链，
//  在 New Architecture 下可能导致 [runtime not ready] 崩溃)。
function getDeviceTranslate() {
  return require('./deviceTranslate').translateDevice;
}
function getAiBatch() {
  return require('./aiProvider').translateAiBatch;
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

/** 根据档位决定翻译调用，返回 [{text, failed}]，failed=该段失败待降级 */
async function translateByEngine(paras, fromLang, toLang, onProgress) {
  const engine = await getTranslateEngine();
  const texts = paras.map(p => p.text);
  // 本机 AI 优先：质量好且免费，失败/没模型自动降级
  if (engine === 'device') {
    try {
      const out = [];
      for (let i = 0; i < texts.length; i++) {
        if (onProgress) onProgress(i + 1, texts.length);
        if (!texts[i].trim()) {
          out.push('');
          continue;
        }
        const zh = await getDeviceTranslate()(texts[i]);
        out.push(zh || '');
      }
      if (onProgress) onProgress(texts.length, texts.length);
      return out.map(t => ({ text: t, failed: false }));
    } catch (e) {
      console.log(`本机翻译失败，切在线AI/机翻：${e.message}`);
    }
  }
  // 在线大模型：质量高，仅当配了 key 才走
  if (engine === 'ai') {
    try {
      const out = await getAiBatch()(texts, fromLang, toLang);
      if (onProgress) onProgress(texts.length, texts.length);
      return out.map(t => ({ text: t || '', failed: t == null }));
    } catch (e) {
      console.log(`在线AI失败，切机翻：${e.message}`);
    }
  }
  // 机翻兜底（默认档）
  const res = await translateTexts(texts, fromLang, toLang);
  if (onProgress) onProgress(texts.length, texts.length);
  return res.map(t => ({ text: t, failed: false }));
}

/**
 * 文本数组翻译（供简介/标题/章节名复用同一引擎路由）。
 * onProgress(done,total) 可选。返回 [{text, failed}] 数组，与输入一一对应。
 */
export async function translateTextsSmart(texts, fromLang = 'en', toLang = 'zh-CN', onProgress = null) {
  const engine = await getTranslateEngine();
  // 本机 AI 优先
  if (engine === 'device') {
    try {
      const out = [];
      for (let i = 0; i < texts.length; i++) {
        if (onProgress) onProgress(i + 1, texts.length);
        if (!texts[i].trim()) { out.push(''); continue; }
        const zh = await getDeviceTranslate()(texts[i]);
        out.push(zh || '');
      }
      if (onProgress) onProgress(texts.length, texts.length);
      return out.map(t => ({ text: t, failed: false }));
    } catch (e) {
      console.log(`本机翻译失败，切在线AI/机翻：${e.message}`);
    }
  }
  // 在线大模型
  if (engine === 'ai') {
    try {
      const out = await getAiBatch()(texts, fromLang, toLang);
      if (onProgress) onProgress(texts.length, texts.length);
      return out.map(t => ({ text: t || '', failed: t == null }));
    } catch (e) {
      console.log(`在线AI失败，切机翻：${e.message}`);
    }
  }
  // 机翻兜底
  const res = await translateTexts(texts, fromLang, toLang);
  if (onProgress) onProgress(texts.length, texts.length);
  return res.map(t => ({ text: t, failed: false }));
}

/**
 * 双语 HTML：mode=bilingual 原文+译文对照；translated 仅译文。
 * onProgress(done,total) 实时进度回调，供 UI 显示"正在翻译 第x/n段"。
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

  const results = await translateByEngine(paras, fromLang, toLang, onProgress);

  // 逐段拼双语：每段译文跟原文后面；失败段返回原文（不崩、不丢内容）
  return paras
    .map((p, i) => {
      const t = results[i]?.text || '';
      if (mode === 'translated') {
        return t ? `<p class="co3-trans">${escapeHtml(t)}</p>` : p.html;
      }
      const trans = t ? `<p class="co3-trans">${escapeHtml(t)}</p>` : '';
      return `${p.html}${trans}`;
    })
    .join('\n');
}
