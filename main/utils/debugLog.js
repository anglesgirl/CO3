import AsyncStorage from '@react-native-async-storage/async-storage';

const ENABLED_KEY = 'debug_logging_enabled';
const LOG_KEY = 'debug_logs';
const MAX_LOGS = 200;

function safeText(value) {
  return String(value ?? '')
    .replace(/_otwarchive_session=[^;\s]+/gi, '_otwarchive_session=<redacted>')
    .replace(/authenticity_token=[^&\s]+/gi, 'authenticity_token=<redacted>')
    .slice(0, 1000);
}

export async function isDebugEnabled() {
  return (await AsyncStorage.getItem(ENABLED_KEY)) === 'true';
}

export async function setDebugEnabled(enabled) {
  await AsyncStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false');
}

export async function debugLog(scope, message) {
  try {
    if (!(await isDebugEnabled())) return;
    const previous = JSON.parse((await AsyncStorage.getItem(LOG_KEY)) || '[]');
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: new Date().toISOString(),
      scope: safeText(scope),
      message: safeText(message),
    };
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify([entry, ...previous].slice(0, MAX_LOGS)));
  } catch (error) {
    console.warn('Unable to write debug log:', error);
  }
}

export async function getDebugLogs() {
  try {
    return JSON.parse((await AsyncStorage.getItem(LOG_KEY)) || '[]');
  } catch {
    return [];
  }
}

export async function clearDebugLogs() {
  await AsyncStorage.removeItem(LOG_KEY);
}
