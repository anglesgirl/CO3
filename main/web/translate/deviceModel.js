import { Platform } from 'react-native';

/**
 * 本机 AI 模型下载管理。
 *
 * 下载走原生侧（Hymt.downloadModel），不走 RNFS：
 * RNFS 的 DownloadManager（background:true）写不了 app 私有目录，
 * 前台模式对魔搭（阿里云 WAF）也会 Connection reset；原生 HTTP 稳定。
 * 进度由 JS 轮询 Hymt.downloadedBytes 计算（不依赖 bridge 事件）。
 *
 * ⚠️ 两端的模型**不同源**，这是刻意的：
 *
 * Android：用官方 Hy-MT Demo APK 里提取的预编译 libllama.so（CI 提取），
 *   其 ggml 类型编号与官方 GGUF 严格配套：2bit=Q2_0C(41)、1.25bit=STQ_0(40)。
 *   自编 llama.cpp 会因编号错位导致加载失败（几十毫秒即返回 false），
 *   故 Android 必须用官方预编译库 + 官方私有量化。
 *
 * iOS：没有官方 .so，必须自编 llama.cpp（含 Metal 后端）。而 llama.cpp 主线
 *   **不认识**上面的私有量化类型（GGUF 里是 Q1_0、file_type=40），
 *   实测加载直接报 "tensor ... has offset X, expected Y / failed to read tensor data"。
 *   所以 iOS 改用**标准量化 Q4_K_M**：体积 570MB → 1.08GB，
 *   但精度实际高于 2bit 稀疏版，译文质量只会更好。
 *   详见 ios/HymtBridge/HymtLlama.mm。
 */
const MODELSCOPE = 'https://modelscope.cn';
const HF = 'https://huggingface.co';
// 国内直连可用（实测 12.7MB/s，支持断点续传）；HF 直连在国内不通，留作兜底。
const HF_MIRROR = 'https://hf-mirror.com';

const IS_IOS = Platform.OS === 'ios';

/** iOS：标准量化（自编 llama.cpp + Metal） */
const IOS_MODELS = {
  q4km: {
    label: 'HyMT Q4（1.08GB，质量优先）',
    file: 'HY-MT1.5-1.8B-Q4_K_M.gguf',
    bytes: 1133080512,
    urls: [
      `${HF_MIRROR}/tencent/HY-MT1.5-1.8B-GGUF/resolve/main/HY-MT1.5-1.8B-Q4_K_M.gguf`,
      `${HF}/tencent/HY-MT1.5-1.8B-GGUF/resolve/main/HY-MT1.5-1.8B-Q4_K_M.gguf`,
    ],
  },
  q6k: {
    label: 'HyMT Q6（1.4GB，更高精度）',
    file: 'HY-MT1.5-1.8B-Q6_K.gguf',
    bytes: 1474778688,
    urls: [
      `${HF_MIRROR}/tencent/HY-MT1.5-1.8B-GGUF/resolve/main/HY-MT1.5-1.8B-Q6_K.gguf`,
      `${HF}/tencent/HY-MT1.5-1.8B-GGUF/resolve/main/HY-MT1.5-1.8B-Q6_K.gguf`,
    ],
  },
};

/** Android：官方私有量化（配官方预编译 libllama.so） */
const ANDROID_MODELS = {
  '2bit': {
    label: 'HyMT 2bit（572MB，质量优先）',
    file: 'Hy-MT1.5-1.8B-2bit.gguf',
    bytes: 600535360,
    urls: [
      MODELSCOPE +
        '/models/AngelSlim/Hy-MT1.5-1.8B-2bit-GGUF/resolve/master/Hy-MT1.5-1.8B-2bit.gguf',
      HF +
        '/AngelSlim/Hy-MT1.5-1.8B-2bit-GGUF/resolve/main/Hy-MT1.5-1.8B-2bit.gguf',
    ],
  },
  '1.25bit': {
    label: 'HyMT 1.25bit（440MB，省空间/更快）',
    file: 'Hy-MT1.5-1.8B-1.25bit.gguf',
    bytes: 461860704,
    urls: [
      MODELSCOPE +
        '/models/AngelSlim/Hy-MT1.5-1.8B-1.25bit-GGUF/resolve/master/Hy-MT1.5-1.8B-1.25bit.gguf',
      HF +
        '/AngelSlim/Hy-MT1.5-1.8B-1.25bit-GGUF/resolve/main/Hy-MT1.5-1.8B-1.25bit.gguf',
    ],
  },
};

export const DEVICE_MODELS = IS_IOS ? IOS_MODELS : ANDROID_MODELS;

export const DEFAULT_DEVICE_MODEL = IS_IOS ? 'q4km' : '2bit';

export async function modelExists(NativeModules, which = DEFAULT_DEVICE_MODEL) {
  try {
    const { Hymt } = NativeModules;
    if (!Hymt) return false;
    const spec = DEVICE_MODELS[which] || DEVICE_MODELS[DEFAULT_DEVICE_MODEL];
    return await Hymt.modelExists(spec.file);
  } catch {
    return false;
  }
}

/**
 * 下载模型到原生约定的目录，onProgress(0~1) 回调进度。
 * 依次尝试 urls（国内源优先），每个源重试 2 次。
 */
export async function downloadModel(
  NativeModules,
  which = DEFAULT_DEVICE_MODEL,
  onProgress,
) {
  const { Hymt } = NativeModules;
  if (!Hymt || typeof Hymt.downloadModel !== 'function') {
    throw new Error('本机模块不可用（需安装新版 App）');
  }
  const spec = DEVICE_MODELS[which] || DEVICE_MODELS[DEFAULT_DEVICE_MODEL];
  const basePath = await Hymt.modelPath();
  const dest = basePath.replace(/[^/]+$/, spec.file);

  // 轮询已下载字节数算进度
  let polling = true;
  const total = spec.bytes || 0;
  const poll = async () => {
    while (polling) {
      try {
        const done = await Hymt.downloadedBytes(dest);
        if (onProgress && total > 0 && done > 0) {
          onProgress(Math.min(done / total, 1));
        }
      } catch {
        // 忽略单次查询失败
      }
      await new Promise(r => setTimeout(r, 600));
    }
  };
  poll();

  let lastError = null;
  try {
    for (let i = 0; i < spec.urls.length; i += 1) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          if (onProgress) onProgress(0);
          const saved = await Hymt.downloadModel(spec.urls[i], dest);
          if (onProgress) onProgress(1);
          return saved;
        } catch (e) {
          lastError = e;
          console.log(
            `模型下载源 ${i + 1} 第 ${attempt} 次失败：${e.message}`,
          );
        }
      }
    }
    throw lastError || new Error('全部下载源失败');
  } finally {
    polling = false;
  }
}
