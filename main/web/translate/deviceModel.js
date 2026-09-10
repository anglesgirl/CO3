/**
 * 本机 AI 模型下载管理：魔搭（国内快）优先，HuggingFace 兜底。
 * 2bit 572MB / 1.25bit 440MB 二选一，默认 2bit。
 * 魔搭支持 range 请求（断点续传），实测国内速度良好。
 */
import RNFS from 'react-native-fs';

const MODELSCOPE = 'https://modelscope.cn';
const HF = 'https://huggingface.co';

export const DEVICE_MODELS = {
  '2bit': {
    label: 'HyMT 2bit（572MB，质量优先）',
    file: 'Hy-MT1.5-1.8B-2bit.gguf',
    urls: [
      // 魔搭（国内）：master 分支
      MODELSCOPE +
        '/models/AngelSlim/Hy-MT1.5-1.8B-2bit-GGUF/resolve/master/Hy-MT1.5-1.8B-2bit.gguf',
      // HuggingFace（海外）兜底
      HF +
        '/AngelSlim/Hy-MT1.5-1.8B-2bit-GGUF/resolve/main/Hy-MT1.5-1.8B-2bit.gguf',
    ],
  },
  '1.25bit': {
    label: 'HyMT 1.25bit（440MB，省空间）',
    file: 'Hy-MT1.5-1.8B-1.25bit.gguf',
    urls: [
      MODELSCOPE +
        '/models/AngelSlim/Hy-MT1.5-1.8B-1.25bit-GGUF/resolve/master/Hy-MT1.5-1.8B-1.25bit.gguf',
      HF +
        '/AngelSlim/Hy-MT1.5-1.8B-1.25bit-GGUF/resolve/main/Hy-MT1.5-1.8B-1.25bit.gguf',
    ],
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

function downloadFrom(url, dest, onProgress) {
  const job = RNFS.downloadFile({
    fromUrl: url,
    toFile: dest,
    // 关键：不能用 background:true（走 Android DownloadManager，
    // 它写不了 app 私有目录 filesDir/，且对魔搭的 cookie/keep-alive 处理会 RST）。
    // background:false 用 RNFS 自身流式下载，可写私有目录，UA 可控。
    background: false,
    connectionTimeout: 30000,
    readTimeout: 60000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      Accept: '*/*',
    },
    progressInterval: 500,
    progress: res => {
      if (onProgress && res.contentLength > 0) {
        onProgress(res.bytesWritten / res.contentLength);
      }
    },
  });
  return job.promise.then(res => {
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      throw new Error(`下载失败（HTTP ${res.statusCode}）`);
    }
    return dest;
  });
}

/**
 * 下载模型到 filesDir/hymt/，onProgress(0~1) 回调进度。
 * 依次尝试 urls（魔搭优先），前一个失败自动切下一个。
 */
export async function downloadModel(
  NativeModules,
  which = DEFAULT_DEVICE_MODEL,
  onProgress,
) {
  const { Hymt } = NativeModules;
  if (!Hymt) throw new Error('本机模块不可用');
  const spec = DEVICE_MODELS[which] || DEVICE_MODELS[DEFAULT_DEVICE_MODEL];
  const basePath = await Hymt.modelPath();
  const dest = basePath.replace(/[^/]+$/, spec.file);

  let lastError = null;
  for (let i = 0; i < spec.urls.length; i += 1) {
    // 每个源重试 2 次（大文件网络抖动难免）
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await downloadFrom(spec.urls[i], dest, onProgress);
      } catch (e) {
        lastError = e;
        console.log(
          `模型下载源 ${i + 1} 第 ${attempt} 次失败：${e.message}`,
        );
        if (onProgress) onProgress(0);
      }
    }
  }
  throw lastError || new Error('全部下载源失败');
}
