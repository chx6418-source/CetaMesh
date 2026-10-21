import {NativeModules} from 'react-native';

export function installedAppVersion(): string {
  const value: unknown = NativeModules.CetaAppInfo?.versionName;
  return typeof value === 'string' && value.trim() ? value : '—';
}
