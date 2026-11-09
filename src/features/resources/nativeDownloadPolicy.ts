import { Platform, UIManager } from 'react-native';

/** A JS package/patch version cannot prove which native binary is running. */
export function supportsResourceBrowser(): boolean {
  if (Platform.OS === 'ios') return true; // onFileDownload is supported on iOS.
  if (Platform.OS !== 'android') return false;
  try {
    const config: unknown = UIManager.getViewManagerConfig('RNCWebView');
    if (!config || typeof config !== 'object' || !('Constants' in config)) return false;
    const constants: unknown = config.Constants;
    return !!constants && typeof constants === 'object'
      && 'topicTrailDownloadPolicyVersion' in constants
      && constants.topicTrailDownloadPolicyVersion === 1;
  } catch {
    // Expo Go, older dev clients and unavailable native interop fail closed.
    return false;
  }
}
