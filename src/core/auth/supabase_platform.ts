import 'react-native-url-polyfill/auto';
import type { SecureStoreOptions } from 'expo-secure-store';
import { AppState } from 'react-native';
import type { SupportedStorage } from '@supabase/supabase-js';
import { AuthOperationError } from './types';

type SecureStoreApi = typeof import('expo-secure-store');
let secureStore: SecureStoreApi | undefined;
function getSecureStore(): SecureStoreApi {
  try {
    // Lazy: preserved binaries without this module must still be able to open Guest Mode.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return secureStore ??= require('expo-secure-store') as SecureStoreApi;
  } catch { throw new AuthOperationError('unavailable', 'Secure session storage is unavailable.'); }
}
function options(store: SecureStoreApi): SecureStoreOptions {
  return { keychainService: 'topictrail.supabase.auth', keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
}
async function available() {
  const store = getSecureStore();
  if (!await store.isAvailableAsync()) throw new AuthOperationError('unavailable', 'Secure session storage is unavailable.');
  return store;
}
export const sessionStorage: SupportedStorage = {
  async getItem(key) { const store = await available(); return store.getItemAsync(key, options(store)); },
  async setItem(key, value) {
    const store = await available(); const settings = options(store);
    await store.setItemAsync(key, value, settings);
    // SecureStore58 Android can resolve after SharedPreferences.commit() returns false.
    // Confirm the same encrypted entry is readable before acknowledging persistence.
    if (await store.getItemAsync(key, settings) !== value) {
      throw new AuthOperationError('unavailable', 'Secure session storage is unavailable.');
    }
  },
  async removeItem(key) { const store = await available(); await store.deleteItemAsync(key, options(store)); },
};
const commands = new Map<string, Promise<unknown>>();
export function runAuthCommand<T>(key: string, action: () => Promise<T>): Promise<T> {
  const operation = (commands.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  commands.set(key, operation);
  void operation.finally(() => { if (commands.get(key) === operation) commands.delete(key); }).catch(() => undefined);
  return operation;
}
export function watchAuthActivity(active: (foreground: boolean) => void) {
  active(AppState.currentState === 'active');
  const subscription = AppState.addEventListener('change', state => active(state === 'active'));
  return () => subscription.remove();
}
export function authCallbackUrl() { return 'topictrail://auth/callback'; }
