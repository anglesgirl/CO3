import RNFS from 'react-native-fs';
import { Buffer } from 'buffer';
import { echFetch } from '../echKy';

const FORMATS = ['azw3', 'epub', 'mobi', 'pdf', 'html'];

// 经 ECH 代理下载（fail-closed：代理没起来就抛错，绝不明文直连）。
// 原来这里直接 import ky 发裸请求，SNI 明文被墙 RST。
async function fetchViaEch(url, { timeoutMs = 120000, retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await echFetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      console.log(`Retrying download (attempt ${attempt + 1})...`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function nativeDownload(workId, format, name) {
  const url = `https://archiveofourown.org/downloads/${workId}/work.${format}`;
  const safeName = name.replace(/[/\\?%*:|"<>]/g, '_');
  const filename = `${safeName}.${format}`;
  const destPath = `${RNFS.DownloadDirectoryPath}/${filename}`;

  try {
    const arrayBuffer = await fetchViaEch(url).then((r) => r.arrayBuffer());

    const base64 = Buffer.from(arrayBuffer).toString('base64');

    await RNFS.writeFile(destPath, base64, 'base64');

    return { success: true, path: destPath };
  } catch (err) {
    console.error('nativeDownload error:', err);
    throw err;
  }
}