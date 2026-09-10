/**
 * 本机 AI 模型下载管理：魔搭（国内快）优先，HuggingFace 兜底。
 *
 * 下载走 Kotlin 侧 OkHttp（Hymt.downloadModel），不走 RNFS：
 * RNFS 的 DownloadManager（background:true）写不了 app 私有目录，
 * 前台模式对魔搭（阿里云 WAF）也会 Connection reset；原生 OkHttp 稳定。
 * 进度由 JS 轮询 Hymt.downloadedBytes 计算（不依赖 bridge 事件）。
 *
 * ⚠️ 使用官方 Demo APK 的预编译 libllama.so（CI 提取），其 ggml 类型编号与官方
 * GGUF 严格配套：2bit=Q2_0C(41)、1.25bit=STQ_0(40)。自编 llama.cpp 会因编号错位
 * 导致加载失败（几十毫秒即返回 false），故必须用官方预编译库。
 */
const MODELSCOPE = 'https://modelscope.cn';
const HF = 'https://huggingface.co';

export const DEVICE_MODELS = {
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

/**
 * 下载模型到 filesDir/hymt/，onProgress(0~1) 回调进度。
 * 依次尝试 urls（魔搭优先），每个源重试 2 次。
 */
export async function downloadModel(
  NativeModules,
  which = DEFAULT_DEVICE_MODEL,
  onProgress,
) {
  const { Hymt } = NativeModules;
  if (!Hymt || typeof Hymt.downloadModel !== 'function') {
    throw new Error('本机模块不可用（需新版 App）');
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
