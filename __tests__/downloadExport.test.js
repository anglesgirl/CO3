import fs from 'fs';
import path from 'path';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('Android downloads', () => {
  it('streams AO3 files through ECH and exports them without a picker', () => {
    const source = read('main/web/download/NativeDownload.js');
    expect(source).toContain('await echRequest(url)');
    expect(source).toContain('RNFS.downloadFile({');
    expect(source).toContain('RNFS.CachesDirectoryPath');
    expect(source).toContain('FileExport.saveToDownloads');
    expect(source).not.toContain('.arrayBuffer()');
    expect(source).not.toContain('RNFS.DownloadDirectoryPath');
  });

  it('registers the Android MediaStore export package', () => {
    const app = read('android/app/src/main/java/com/co3/MainApplication.kt');
    const module = read('android/app/src/main/java/com/co3/export/FileExportModule.kt');
    expect(app).toContain('add(FileExportPackage())');
    expect(module).toContain('MediaStore.Downloads.EXTERNAL_CONTENT_URI');
    expect(module).toContain('Environment.DIRECTORY_DOWNLOADS + "/CO3"');
    expect(module).toContain('Intent.ACTION_VIEW');
    expect(module).toContain('fun openFile(');
  });

  it('shows the exact folder and offers to open a manual download', () => {
    const screen = read('main/screens/workScreen.jsx');
    const exporter = read('main/storage/FileExport.js');
    expect(screen).toContain("t('screen_work_download_location'");
    expect(screen).toContain("t('screen_work_download_open')");
    expect(screen).toContain('FileExport.openFile');
    expect(exporter).toContain('nativeModule.openFile');
  });

  it('keeps automatic chapter downloads in app storage', () => {
    const downloader = read('main/downloads/Downloader.js');
    const chapterRequest = read('main/web/worksScreen/fetchChapter.js');
    expect(downloader).toContain('RNFS.DocumentDirectoryPath');
    expect(downloader).toContain('await fetchChapter(workId, chapterId, true)');
    expect(downloader).toContain("throw new Error('Chapter download was not saved')");
    expect(downloader).toContain('throw err;');
    expect(chapterRequest).toContain("import getUrl from '../requestManager'");
  });

  it('hides database export from the menu and navigator', () => {
    const menu = read('main/screens/More.jsx');
    const app = read('main/app.jsx');
    expect(menu).not.toContain("handlePress('Data and Storage')");
    expect(menu).not.toContain("case 'Data and Storage'");
    expect(app).not.toContain('StorageScreen');
  });

  it('does not show the unavailable update placeholder', () => {
    const update = read('main/screens/Update.jsx');
    expect(update).not.toContain("t('screen_update_not_available')");
    expect(update).not.toContain("DeviceEventEmitter.addListener('doubleTap'");
  });
});
