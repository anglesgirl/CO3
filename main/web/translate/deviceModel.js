/**
 * 本机 AI 模型下载管理：直连官方 HF 地址（不自建封装）。
 * 2bit 574MB / 1.25bit 440MB 二选一，默认 2bit（已真机验证）。
 */
import RNFS from 'react-native-fs';

const HF_BASE = 'https://huggingface.co';

export const DEVICE_MODELS = {
  '2bit': {
    label: 'HyMT 2bit（574MB，质量优先）',
    url:
      HF_BASE +
      '/AngelSlim/Hy-MT1.5-1.8B-2bit-GGUF/resolve/main/Hy-MT1.5-1.8B-2bit.gguf',
    file: 'Hy-MT1.5-1.8B-2bit.gguf',
  },
  '1.25bit': {
    label: 'HyMT 1.25bit（440MB，省空间）',
    url:
      HF_BASE +
      '/AngelSlim/Hy-MT1.5-1.8B-1.25bit-GGUF/resolve/main/Hy-MT1.5-1.8B-1.25bit.gguf',
    file: 'Hy-MT1.5-1.8B-1.25bit.gguf',
  },
};

export const DEFAULT_DEVICE_MODEL = '2bit';

export async function modelExists(NativeModules) {
  try {
    const { Hymt } = NativeModules;
    if (!Hymt) return false;
    return await Hymt.modelExists();
  } catch {
    return false;
  }
}

/** 官方直链下载模型到 filesDir/hymt/，onProgress(0~1) 回调进度。 */
export function downloadModel(NativeModules, which = DEFAULT_DEVICE_MODEL, onProgress) {
  const { Hymt } = NativeModules;
  if (!Hymt) return Promise.reject(new Error('本机模块不可用'));
  const spec = DEVICE_MODELS[which] || DEVICE_MODELS[DEFAULT_DEVICE_MODEL];
  return Hymt.modelPath().then(basePath => {
    const dest = basePath.replace(/[^/]+$/, spec.file);
    const job = RNFS.downloadFile({
      fromUrl: spec.url,
      toFile: dest,
      background: true,
      discretionary: true,
      progressInterval: 500,
      progress: res => {
        if (onProgress && res.contentLength > 0) {
          onProgress(res.bytesWritten / res.contentLength);
        }
      },
    });
    return job.promise.then(res => {
      if (res.statusCode !== 200) {
        throw new Error(`下载失败（${res.statusCode}）`);
      }
      return dest;
    });
  });
}