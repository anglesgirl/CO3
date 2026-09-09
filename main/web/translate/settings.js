/** 翻译偏好：AsyncStorage 持久化，不动 SQLite（免迁移）。 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const TRANSLATE_MODE_KEY = 'co3_translate_mode';
export const TRANSLATE_ENGINE_KEY = 'co3_translate_engine';

/** off=原文 bilingual=双语对照 translated=仅译文 */
export async function getTranslateMode() {
  return (await AsyncStorage.getItem(TRANSLATE_MODE_KEY)) || 'off';
}

export async function setTranslateMode(mode) {
  await AsyncStorage.setItem(TRANSLATE_MODE_KEY, mode);
}

/** auto=在线免费机翻 device=本机AI（HyMT 端侧，需先下载模型） */
export async function getTranslateEngine() {
  return (await AsyncStorage.getItem(TRANSLATE_ENGINE_KEY)) || 'auto';
}

export async function setTranslateEngine(engine) {
  await AsyncStorage.setItem(TRANSLATE_ENGINE_KEY, engine);
}
