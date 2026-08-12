// translate.js — on-demand translation of AO3 content.
//
// Backend: the free Google Translate "gtx" endpoint (no API key). Because that
// host is often unreachable from censored networks, the endpoint is
// configurable and can be pushed remotely via the same TXT record used for the
// ECH settings (key `tr=`), so a mirror can be swapped in without a new build.
//
// The HTML path preserves markup: only text nodes are translated, tags are
// left untouched, so paragraphs/italics/links survive.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { echFetch } from './echKy';

export const DEFAULT_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

const ENDPOINT_KEY = 'translate_endpoint';
const TARGET_KEY = 'translate_target';
const CACHE_PREFIX = 'tr_cache_';

// Max characters per network request. Google's gtx endpoint is a GET, so the
// whole batch has to fit in a URL.
const BATCH_CHARS = 1200;
const CONCURRENCY = 3;

export async function getEndpoint() {
  try {
    return (await AsyncStorage.getItem(ENDPOINT_KEY)) || DEFAULT_TRANSLATE_ENDPOINT;
  } catch {
    return DEFAULT_TRANSLATE_ENDPOINT;
  }
}

export async function setEndpoint(url) {
  await AsyncStorage.setItem(ENDPOINT_KEY, url ?? '');
}

// Target language. Defaults to the app's UI language when unset.
export async function getTargetLang(fallback = 'zh-CN') {
  try {
    return (await AsyncStorage.getItem(TARGET_KEY)) || fallback;
  } catch {
    return fallback;
  }
}

export async function setTargetLang(lang) {
  await AsyncStorage.setItem(TARGET_KEY, lang ?? '');
}

// --- core call ------------------------------------------------------------

// translateChunkPairs sends one string and returns per-segment
// { translated, original } pairs. The gtx endpoint echoes the original text
// (segment [1]), which lets us build bilingual output with zero extra calls.
async function translateChunkPairs(text, target, endpoint) {
  const url =
    `${endpoint}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;

  // Routed through the ECH proxy so DNS poisoning can't block the lookup.
  const res = await echFetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
  const data = await res.json();

  // Response shape: [[["translated","original",...], ...], ...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('unexpected translate response');
  }
  return data[0].map(seg =>
    Array.isArray(seg)
      ? { translated: seg[0] ?? '', original: seg[1] ?? '' }
      : { translated: '', original: '' },
  );
}

// translateChunk sends one string and returns its translation.
async function translateChunk(text, target, endpoint) {
  const pairs = await translateChunkPairs(text, target, endpoint);
  const translated = pairs.map(p => p.translated).join('');
  // Google 可能整段返回空译文；不要用空串覆盖原文（否则纯文本摘要整段消失）。
  return translated && translated.trim() ? translated : text;
}

// Runs jobs with a small concurrency limit so we don't hammer the endpoint.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// --- plain text -----------------------------------------------------------

export async function translateText(text, target, endpoint) {
  if (!text || !text.trim()) return text;
  const tl = target || (await getTargetLang());
  const ep = endpoint || (await getEndpoint());
  if (text.length <= BATCH_CHARS) return translateChunk(text, tl, ep);

  // Split long text on paragraph boundaries.
  const parts = [];
  let buf = '';
  for (const para of text.split(/\n{2,}/)) {
    if ((buf + para).length > BATCH_CHARS && buf) {
      parts.push(buf);
      buf = '';
    }
    buf += (buf ? '\n\n' : '') + para;
  }
  if (buf) parts.push(buf);

  const done = await mapLimit(parts, CONCURRENCY, p => translateChunk(p, tl, ep));
  return done.join('\n\n');
}

// --- HTML -----------------------------------------------------------------

// Splits HTML into tags and text nodes. Content inside <script>/<style> is
// treated as a tag (never translated).
function tokenizeHtml(html) {
  const tokens = [];
  const re = /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) tokens.push({ tag: false, v: html.slice(last, m.index) });
    tokens.push({ tag: true, v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < html.length) tokens.push({ tag: false, v: html.slice(last) });
  return tokens;
}

// Only translate text that actually contains letters.
function isTranslatable(s) {
  return /[A-Za-zÀ-ÿЀ-ӿ]/.test(s);
}

/**
 * translateHtml translates the text nodes of `html`, leaving markup intact.
 * Text nodes are grouped into batches separated by a newline; if the provider
 * doesn't return the same number of lines we fall back to translating that
 * batch's pieces individually, so a mismatch can never scramble the chapter.
 *
 * When `bilingual` is true, each text node is emitted as
 *   <span class="co3-tr">译文</span><span class="co3-orig">原文</span>
 * so a stylesheet can render the original as muted text under the translation.
 */
export async function translateHtml(html, target, endpoint, onProgress, bilingual = false) {
  if (!html) return html;
  const tl = target || (await getTargetLang());
  const ep = endpoint || (await getEndpoint());

  const tokens = tokenizeHtml(html);
  const idxs = [];
  tokens.forEach((tk, i) => {
    if (!tk.tag && isTranslatable(tk.v)) idxs.push(i);
  });
  if (idxs.length === 0) return html;

  // Group text nodes into batches under BATCH_CHARS.
  const batches = [];
  let cur = [];
  let curLen = 0;
  for (const i of idxs) {
    const len = tokens[i].v.length;
    if (curLen + len > BATCH_CHARS && cur.length) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(i);
    curLen += len;
  }
  if (cur.length) batches.push(cur);

  let done = 0;
  await mapLimit(batches, CONCURRENCY, async batch => {
    // Preserve each node's leading/trailing whitespace; translate the core.
    const cores = batch.map(i => tokens[i].v.trim());
    const joined = cores.join('\n');
    let results = null;
    let originals = null;
    try {
      const out = await translateChunkPairs(joined, tl, ep);
      const lines = out.map(p => p.translated).filter(l => l !== '');
      if (lines.length === cores.length) {
        results = lines;
        originals = out.map(p => p.original);
      }
    } catch {
      // fall through to per-node translation
    }
    if (!results) {
      const pairs = await mapLimit(cores, 1, async c => {
        try {
          const p = await translateChunkPairs(c, tl, ep);
          // Google 可能对短文本返回空串译文（''）。'??' 只对 null/undefined
          // 回退原文，空串会被原样写入 → 该文本节点消失（摘要有片段被跳过）。
          // 必须把 '' 也一并回退为原文。
          const t = p[0]?.translated;
          const o = p[0]?.original;
          return {
            translated: (t && t.trim()) ? t : c,
            original: (o && o.trim()) ? o : c,
          };
        } catch {
          return { translated: c, original: c };
        }
      });
      results = pairs.map(p => p.translated);
      originals = pairs.map(p => p.original);
    }
    batch.forEach((tokenIdx, k) => {
      const original = tokens[tokenIdx].v;
      const lead = original.match(/^\s*/)[0];
      const trail = original.match(/\s*$/)[0];
      const translated = results[k] ?? original.trim();
      if (bilingual) {
        const origText = originals?.[k] ?? original.trim();
        tokens[tokenIdx].v =
          lead +
          `<span class="co3-tr">${translated}</span>` +
          `<span class="co3-orig">${origText}</span>` +
          trail;
      } else {
        tokens[tokenIdx].v = lead + translated + trail;
      }
    });
    done += 1;
    onProgress?.(done, batches.length);
  });

  return tokens.map(tk => tk.v).join('');
}

// --- cache ----------------------------------------------------------------

// Small stable hash so we can cache a translated chapter without storing the key.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function getCached(key, source) {
  try {
    return await AsyncStorage.getItem(CACHE_PREFIX + key + '_' + hash(source));
  } catch {
    return null;
  }
}

export async function setCached(key, source, value) {
  try {
    await AsyncStorage.setItem(CACHE_PREFIX + key + '_' + hash(source), value);
  } catch {}
}

/** Translates HTML with a cache keyed on the source text. */
export async function translateHtmlCached(cacheKey, html, target, onProgress, bilingual = false) {
  const tl = target || (await getTargetLang());
  const k = `${cacheKey}_${tl}${bilingual ? '_bi' : ''}`;
  const hit = await getCached(k, html);
  if (hit) return hit;
  const out = await translateHtml(html, tl, undefined, onProgress, bilingual);
  await setCached(k, html, out);
  return out;
}
