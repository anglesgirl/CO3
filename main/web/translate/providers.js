/**
 * 免费在线翻译引擎（移植自 FluentRead，GPL-3.0，原文件：
 * src/providers/translation/{google,microsoft,mymemory}.ts）。
 * 只保留纯 fetch 调用逻辑，去掉其 runtime/abort 基础设施，改用
 * AbortController + setTimeout 实现超时。
 */

const GOOGLE_LEGACY_URL = 'https://translate.googleapis.com/translate_a/single';
const MICROSOFT_URL = 'https://edge.microsoft.com/translate/translatetext';
const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

function fetchWithTimeout(url, init = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() =>
    clearTimeout(timer),
  );
}

function joinSegments(arr) {
  if (!Array.isArray(arr)) return null;
  const text = arr
    .map(seg => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
    .join('');
  return text.length > 0 ? text : null;
}

/** Google 免费 legacy 接口：GET single?client=gtx */
export async function translateGoogle(text, fromLang = 'en', toLang = 'zh-CN') {
  const url =
    `${GOOGLE_LEGACY_URL}?client=gtx&sl=${encodeURIComponent(fromLang)}` +
    `&tl=${encodeURIComponent(toLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) throw new Error(`谷歌翻译失败：HTTP ${resp.status}`);
  const body = await resp.text();
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error('谷歌翻译返回格式异常');
  }
  const out = joinSegments(result?.[0]);
  if (out === null) throw new Error('谷歌翻译返回为空');
  return out;
}

/** 微软 Edge 免费接口：POST，天然支持批量 */
export async function translateMicrosoftBatch(
  texts,
  fromLang = 'en',
  toLang = 'zh-CN',
) {
  if (texts.length === 0) return [];
  const url =
    `${MICROSOFT_URL}?from=${encodeURIComponent(fromLang)}` +
    `&to=${encodeURIComponent(toLang)}&isEnterpriseClient=false`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(texts),
  });
  if (!resp.ok) throw new Error(`微软翻译失败：HTTP ${resp.status}`);
  const result = await resp.json();
  if (!Array.isArray(result) || result.length !== texts.length) {
    throw new Error('微软翻译返回数量异常');
  }
  return result.map((item, i) => {
    const t = item?.translations?.[0]?.text;
    if (typeof t !== 'string') throw new Error(`微软翻译第 ${i + 1} 条缺译文`);
    return t;
  });
}

export async function translateMicrosoft(text, fromLang, toLang) {
  return (await translateMicrosoftBatch([text], fromLang, toLang))[0];
}

/** MyMemory 官方免费 API：匿名每天 5000 字符 */
export async function translateMyMemory(text, fromLang = 'en', toLang = 'zh-CN') {
  const url =
    `${MYMEMORY_URL}?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(fromLang)}|${encodeURIComponent(toLang)}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) throw new Error(`MyMemory 失败：HTTP ${resp.status}`);
  const result = await resp.json();
  const out = result?.responseData?.translatedText;
  if (typeof out !== 'string' || out.length === 0) {
    throw new Error('MyMemory 返回为空');
  }
  return out;
}
