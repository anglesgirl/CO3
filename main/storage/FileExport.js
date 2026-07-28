import RNFS from 'react-native-fs';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

async function requestLegacyStoragePermission() {
  if (Platform.OS !== 'android' || Platform.Version >= 29) return;
  const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
  const granted = await PermissionsAndroid.request(permission);
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('Storage permission denied');
  }
}

async function saveOnIos(sourcePath, displayName) {
  const target = `${RNFS.DocumentDirectoryPath}/${displayName}`;
  if (await RNFS.exists(target)) await RNFS.unlink(target);
  await RNFS.copyFile(sourcePath, target);
  return target;
}

const FileExport = {
  async saveToDownloads(sourcePath, displayName, mimeType) {
    if (Platform.OS === 'ios') return saveOnIos(sourcePath, displayName);
    if (Platform.OS !== 'android') throw new Error('Unsupported export platform');
    await requestLegacyStoragePermission();
    const nativeModule = NativeModules.FileExport;
    if (!nativeModule?.saveToDownloads) throw new Error('File export module unavailable');
    return nativeModule.saveToDownloads(sourcePath, displayName, mimeType);
  },
};

export default FileExport;
