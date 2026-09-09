/**
 * 在线大模型 AI 翻译（OpenAI 兼容端点，默认 DeepSeek）。
 * 针对小说/同人优化译文腔调：保留人名、专有名词、语气词、笑点，避免机翻生硬。
 * key 只从本地 AsyncStorage 读取，绝不写进 git、日志或打包进包。
 */
import { getAiEndpoint, getAiApiKey, getAiModel } from './settings';

function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/** 每段翻译前拼系统提示：小说翻译要求（避免翻译腔） */
const SYS_PROMPT =
  '你是专业的英文→简体中文小说/同人翻译。要求：' +
  '1) 保留人名、地名、原作专有名词不译；' +
  '2) 保留英文语气词、俚语、双关、笑点，必要时加中文注释；' +
  '3) 译文通顺自然，符合中文网文阅读习惯，避免谷歌式生硬翻译腔；' +
  '4) 只输出译文本身，不要任何解释、前缀或引号。';

async function callChat(text, endpoint, apiKey, model) {
  const resp = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3, // 翻译要稳定，低温
      messages: [
        { role: 'system', content: SYS_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`AI 翻译失败：HTTP ${resp.status}（${errText.slice(0, 120)}）`);
  }
  const body = await resp.json();
  const out = body?.choices?.[0]?.message?.content;
  if (typeof out !== 'string') throw new Error('AI 翻译返回格式异常');
  return out.trim();
}

/** 单段翻译（AI 不适合并发大批量，逐段串行控制质量与限流） */
export async function translateAi(text, fromLang = 'en', toLang = 'zh-CN') {
  const endpoint = await getAiEndpoint();
  const apiKey = await getAiApiKey();
  if (!apiKey) throw new Error('未配置 AI key');
  const model = await getAiModel();
  return callChat(text, endpoint, apiKey, model);
}

/**
 * 多段翻译：按 4 段一批串行 + 批内并发，控制速度和限流。
 * 大模型质量高但请求慢；一次性几十段会拖垮界面，这里限量分批。
 */
export async function translateAiBatch(texts, fromLang = 'en', toLang = 'zh-CN') {
  const endpoint = await getAiEndpoint();
  const apiKey = await getAiApiKey();
  if (!apiKey) throw new Error('未配置 AI key');
  const model = await getAiModel();

  const out = new Array(texts.length);
  const BATCH = 4; // 每批并发段数，过大多模型会限流
  const CONCURRENCY = 2; // 同时跑的批数，控制启动压力
  let cursor = 0;

  async function worker() {
    while (cursor < texts.length) {
      const batchStart = cursor;
      const batch = [];
      for (let i = 0; i < BATCH && cursor < texts.length; i++, cursor++) {
        batch.push({ idx: cursor, text: texts[cursor] });
      }
      await Promise.all(
        batch.map(async ({ idx, text }) => {
          try {
            out[idx] = await callChat(text, endpoint, apiKey, model);
          } catch (e) {
            out[idx] = null; // 单段失败标记，由上层降级
          }
        }),
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}
