import RNFS from 'react-native-fs';
import FileExport from '../../storage/FileExport';
import { echRequest } from '../echKy';
import { getSessionHeaders } from '../sessionHeaders';

const FORMATS = ['azw3', 'epub', 'mobi', 'pdf', 'html'];

export async function nativeDownload(workId, format, name) {
  if (!FORMATS.includes(format)) throw new Error('Unsupported download format');
  const url = `https://download.archiveofourown.org/downloads/${workId}/work.${format}`;
  const safeName = String(name || `work_${workId}`).replace(/[/\\?%*:|"<>]/g, '_');
  const filename = `${safeName}.${format}`;
  const tempPath = `${RNFS.CachesDirectoryPath}/co3-${workId}-${Date.now()}.${format}`;

  try {
    const request = await echRequest(url);
    const headers = { ...request.headers, ...(await getSessionHeaders(false)) };
    await streamDownload(request.url, tempPath, headers);
    const path = await FileExport.saveToDownloads(tempPath, filename, mimeType(format));
    return { success: true, path };
  } catch (err) {
    console.error('nativeDownload error:', err);
    throw err;
  } finally {
    if (await RNFS.exists(tempPath)) await RNFS.unlink(tempPath).catch(() => {});
  }
}

async function streamDownload(url, target, headers) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const task = RNFS.downloadFile({ fromUrl: url, toFile: target, headers });
      const result = await withTimeout(task, 180000);
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`Download failed with status ${result.statusCode}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (await RNFS.exists(target)) await RNFS.unlink(target).catch(() => {});
    }
  }
  throw lastError;
}

function withTimeout(task, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        RNFS.stopDownload(task.jobId);
      } catch {}
      reject(new Error('Download timed out'));
    }, timeoutMs);
  });
  return Promise.race([task.promise, timeout]).finally(() => clearTimeout(timer));
}

function mimeType(format) {
  const types = {
    azw3: 'application/vnd.amazon.ebook',
    epub: 'application/epub+zip',
    mobi: 'application/x-mobipocket-ebook',
    pdf: 'application/pdf',
    html: 'text/html',
  };
  return types[format];
}
