/** 翻译偏好：AsyncStorage 持久化，不动 SQLite（免迁移）。 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const TRANSLATE_MODE_KEY = 'co3_translate_mode';
export const TRANSLATE_ENGINE_KEY = 'co3_translate_engine';
// 在线 AI（OpenAI 兼容端点，key 纯本地存储，不上传）
export const AI_ENDPOINT_KEY = 'co3_ai_endpoint';
export const AI_API_KEY_KEY = 'co3_ai_api_key';
export const AI_MODEL_KEY = 'co3_ai_model';

/** off=原文 bilingual=双语对照 translated=仅译文 */
export async function getTranslateMode() {
  return (await AsyncStorage.getItem(TRANSLATE_MODE_KEY)) || 'off';
}

export async function setTranslateMode(mode) {
  await AsyncStorage.setItem(TRANSLATE_MODE_KEY, mode);
}

/**
 * 在线引擎选择：
 *  free   = 机翻（谷歌/微软/MyMemory 免费链，质量一般但零配置零额度）
 *  ai     = 在线大模型 AI（OpenAI 兼容端点，用户填 key，质量高）
 *  device = 本机 HyMT（端侧小模型，免费无限，需先下载模型，质量中等偏上）
 *  auto   = 旧值，按 free 对待（默认机翻）
 */
export async function getTranslateEngine() {
  const v = (await AsyncStorage.getItem(TRANSLATE_ENGINE_KEY)) || 'free';
  return v === 'auto' ? 'free' : v;
}

export async function setTranslateEngine(engine) {
  await AsyncStorage.setItem(TRANSLATE_ENGINE_KEY, engine);
}

/** 在线 AI 端点（OpenAI 兼容，/v1/chat/completions），默认 DeepSeek */
export async function getAiEndpoint() {
  return (await AsyncStorage.getItem(AI_ENDPOINT_KEY)) || 'https://api.deepseek.com/v1/chat/completions';
}

export async function setAiEndpoint(endpoint) {
  await AsyncStorage.setItem(AI_ENDPOINT_KEY, endpoint);
}

/** 在线 AI key（本地存储，绝不写进 git/日志） */
export async function getAiApiKey() {
  return (await AsyncStorage.getItem(AI_API_KEY_KEY)) || '';
}

export async function setAiApiKey(key) {
  // 去首尾空白，防止手滑
  await AsyncStorage.setItem(AI_API_KEY_KEY, (key || '').trim());
}

/** 在线 AI 模型，默认 deepseek-chat（小说翻译质量好） */
export async function getAiModel() {
  return (await AsyncStorage.getItem(AI_MODEL_KEY)) || 'deepseek-chat';
}

export async function setAiModel(model) {
  await AsyncStorage.setItem(AI_MODEL_KEY, model);
}

/** 是否有可用的 AI key */
export async function hasAiKey() {
  return (await getAiApiKey()).length > 0;
}
